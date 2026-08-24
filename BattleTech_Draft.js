/* BattleTech TCG-Arena guided Draft.
 *
 * Move exactly one card from the active Patrol pack to DraftPool, then press
 * Confirm Pick & Pass. The script validates the pick, transfers every
 * remaining card to the next drafter, reverses Pack 2, and advances after the
 * last card in a pack has been taken.
 */

const BT_DRAFT_PACK_SECTIONS = {
  1: "Mission",
  2: "Mission2",
  3: "Mission3",
}

function btDraftFindMyPlayerId() {
  const preferredSections = [
    "DraftPool",
    "Discard",
    "Hand",
    "Mission",
    "Mission2",
    "Mission3",
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

function btDraftSeatProgress(controller, position) {
  const key = String(position)
  controller.progress = { ...(controller.progress ?? {}) }
  controller.progress[key] = {
    activePack: 1,
    confirmedPicks: 0,
    ...(controller.progress[key] ?? {}),
  }
  return controller.progress[key]
}

async function btDraftClaimStartingPacks() {
  for (const sectionName of Object.values(BT_DRAFT_PACK_SECTIONS)) {
    const unownedCards = [...(cards?.[sectionName] ?? [])].filter(
      (card) => card?.owner === "UNOWNED"
    )
    if (unownedCards.length > 0) {
      await functions.moveCards(unownedCards, sectionName, { noLogs: true })
    }
  }
}

async function btDraftRegisterPlayer(quiet = true) {
  const controller = game?.data?.DraftController
  if (!controller) return undefined

  const playerId = btDraftFindMyPlayerId()
  if (!playerId) {
    if (!quiet) {
      functions.chatLog("Draft seats: no owned card was found. Wait for setup, then try again.")
    }
    return undefined
  }

  const position = Number(game?.turn?.orderPosition ?? 0)
  controller.players = {
    ...(controller.players ?? {}),
    [String(position)]: playerId,
  }
  controller.registeredCount = Object.values(controller.players).filter(Boolean).length
  btDraftSeatProgress(controller, position)
  await btDraftClaimStartingPacks()

  if (!quiet) {
    functions.chatLog(
      `Draft seats: registered seat ${position + 1} (${controller.registeredCount}/${game.turn.totalPlayers}).`
    )
  }
  return playerId
}

async function btDraftConfirmPickAndPass() {
  const controller = game?.data?.DraftController
  if (!controller) return

  const myPlayerId = await btDraftRegisterPlayer(true)
  if (!myPlayerId) {
    functions.chatLog("Draft: your seat is not registered. Click Refresh Seats.")
    return
  }

  const totalPlayers = Number(game?.turn?.totalPlayers ?? 0)
  if (totalPlayers < 2) {
    functions.chatLog("Draft: at least two players are required.")
    return
  }

  const myPosition = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, myPosition)
  const packNumber = Number(progress.activePack ?? 1)
  const sectionName = BT_DRAFT_PACK_SECTIONS[packNumber]
  if (!sectionName) {
    functions.chatLog("Draft: all three packs are complete.")
    return
  }

  const ownedPicks = [...(cards?.DraftPool ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  const newPickCount = ownedPicks.length - Number(progress.confirmedPicks ?? 0)
  if (newPickCount !== 1) {
    functions.chatLog(
      newPickCount < 1
        ? `Draft: move exactly one card from Pack ${packNumber} to Draft Picks first.`
        : `Draft: ${newPickCount} unconfirmed cards are in Draft Picks. Return cards until exactly one new pick remains.`
    )
    return
  }

  const remainingCards = [...(cards?.[sectionName] ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  progress.confirmedPicks = ownedPicks.length

  if (remainingCards.length === 0) {
    progress.activePack = packNumber + 1
    if (progress.activePack <= 3) {
      functions.chatLog(
        `Draft: Pack ${packNumber} is complete. Begin Pack ${progress.activePack}.`
      )
    } else {
      functions.chatLog("Draft: all three packs are complete.")
    }
    return
  }

  const direction = packNumber === 2 ? -1 : 1
  const targetPosition = (myPosition + direction + totalPlayers) % totalPlayers
  const targetPlayerId = controller.players?.[String(targetPosition)]
  if (!targetPlayerId) {
    progress.confirmedPicks -= 1
    functions.chatLog(
      `Draft: seat ${targetPosition + 1} is not registered. Every player should click Refresh Seats once.`
    )
    return
  }

  for (const card of remainingCards) {
    await functions.giveCardTo(card, targetPlayerId, sectionName)
  }

  functions.chatLog(
    `Draft: confirmed one pick and passed ${remainingCards.length} remaining card${remainingCards.length === 1 ? "" : "s"} from Pack ${packNumber} to seat ${targetPosition + 1}.`
  )
}
