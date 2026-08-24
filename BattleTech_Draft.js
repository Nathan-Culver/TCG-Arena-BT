/* BattleTech TCG-Arena Draft pack passing.
 *
 * Players take one card from a Patrol pack and move it to DraftPool. The
 * matching button then transfers ownership of every card left in that pack to
 * the next drafter. Pack 2 reverses direction, as in a conventional draft.
 */

function btDraftFindMyPlayerId() {
  const preferredSections = [
    "Mission",
    "Mission2",
    "Mission3",
    "DraftPool",
    "Discard",
    "Deck",
    "Hand",
  ]

  for (const sectionName of preferredSections) {
    const sectionCards = cards?.[sectionName] ?? []
    const ownedCard = sectionCards.find(
      (card) => card?.owner && card.owner !== "UNOWNED"
    )
    if (ownedCard) return ownedCard.owner
  }

  return undefined
}

async function btDraftRegisterPlayer(quiet = true) {
  const controller = game?.data?.DraftController
  if (!controller) return undefined

  const playerId = btDraftFindMyPlayerId()
  if (!playerId) {
    if (!quiet) {
      functions.chatLog("Draft seats: no owned card was found. Try again after setup finishes.")
    }
    return undefined
  }

  const position = Number(game?.turn?.orderPosition ?? 0)
  controller.players = {
    ...(controller.players ?? {}),
    [String(position)]: playerId,
  }
  controller.registeredCount = Object.values(controller.players).filter(Boolean).length

  if (!quiet) {
    functions.chatLog(
      `Draft seats: registered seat ${position + 1} (${controller.registeredCount}/${game.turn.totalPlayers}).`
    )
  }
  return playerId
}

async function btDraftPassPack(packNumber) {
  const packSections = {
    1: "Mission",
    2: "Mission2",
    3: "Mission3",
  }
  const sectionName = packSections[packNumber]
  if (!sectionName) {
    functions.chatLog("Draft: unknown pack number.")
    return
  }

  const myPlayerId = await btDraftRegisterPlayer(true)
  if (!myPlayerId) {
    functions.chatLog("Draft: your seat is not registered. Click Refresh Seats.")
    return
  }

  const totalPlayers = Number(game?.turn?.totalPlayers ?? 0)
  if (totalPlayers < 2) {
    functions.chatLog("Draft: at least two players are required to pass packs.")
    return
  }

  const myPosition = Number(game?.turn?.orderPosition ?? 0)
  const direction = packNumber === 2 ? -1 : 1
  const targetPosition = (myPosition + direction + totalPlayers) % totalPlayers
  const targetPlayerId = game.data.DraftController.players?.[String(targetPosition)]

  if (!targetPlayerId) {
    functions.chatLog(
      `Draft: seat ${targetPosition + 1} is not registered. Every player should click Refresh Seats once.`
    )
    return
  }

  const remainingCards = [...(cards?.[sectionName] ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )

  if (remainingCards.length === 0) {
    functions.chatLog(`Draft: Pack ${packNumber} has no cards left to pass.`)
    return
  }

  for (const card of remainingCards) {
    await functions.giveCardTo(card, targetPlayerId, sectionName)
  }

  functions.chatLog(
    `Draft: passed ${remainingCards.length} card${remainingCards.length === 1 ? "" : "s"} from Pack ${packNumber} to seat ${targetPosition + 1}.`
  )
}
