/* BattleTech TCG-Arena guided Draft.
 *
 * Move exactly one card from the active Patrol pack to DraftPool, then press
 * Confirm Pick & Pass. Each seat locks its pick; only after every player has
 * confirmed does the script exchange the remaining packs through a hidden
 * incoming queue. Pack 2 reverses direction.
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
    packPickNumber: 0,
    waitingRound: null,
    awaitingIncomingPack: null,
    ...(controller.progress[key] ?? {}),
  }
  return controller.progress[key]
}

function btDraftRound(controller, roundKey, packNumber, pickNumber) {
  controller.rounds = { ...(controller.rounds ?? {}) }
  controller.rounds[roundKey] = {
    packNumber,
    pickNumber,
    ready: {},
    pickIds: {},
    released: {},
    ...(controller.rounds[roundKey] ?? {}),
  }
  return controller.rounds[roundKey]
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

async function btDraftLoadIncomingPack(myPlayerId, progress) {
  const packNumber = Number(progress.awaitingIncomingPack ?? 0)
  const sectionName = BT_DRAFT_PACK_SECTIONS[packNumber]
  if (!sectionName) return false

  const incomingCards = [...(cards?.DraftIncoming ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  const currentOwnedCards = [...(cards?.[sectionName] ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  if (currentOwnedCards.length > 0 || incomingCards.length === 0) return false

  await functions.moveCards(incomingCards, sectionName, { noLogs: true })
  progress.awaitingIncomingPack = null
  return true
}

async function btDraftProcessReadyRounds() {
  const controller = game?.data?.DraftController
  if (!controller) return

  const myPlayerId = await btDraftRegisterPlayer(true)
  if (!myPlayerId) return

  const totalPlayers = Number(game?.turn?.totalPlayers ?? 0)
  const myPosition = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, myPosition)
  await btDraftLoadIncomingPack(myPlayerId, progress)
  const roundKey = progress.waitingRound
  if (!roundKey) return

  const round = controller.rounds?.[roundKey]
  if (!round) return
  const readyCount = Object.values(round.ready ?? {}).filter(Boolean).length
  if (readyCount < totalPlayers) return
  if (round.released?.[String(myPosition)]) return

  const packNumber = Number(round.packNumber)
  const sectionName = BT_DRAFT_PACK_SECTIONS[packNumber]
  if (!sectionName) return

  const direction = packNumber === 2 ? -1 : 1
  const targetPosition = (myPosition + direction + totalPlayers) % totalPlayers
  const targetPlayerId = controller.players?.[String(targetPosition)]
  if (!targetPlayerId) {
    functions.chatLog(
      `Draft: seat ${targetPosition + 1} is not registered. Every player should click Refresh Seats once.`
    )
    return
  }

  round.released = { ...(round.released ?? {}) }
  // Set the guard before transferring because every transferred card can fire
  // another onCardsUpdate event.
  round.released[String(myPosition)] = "running"

  // Bank the locked pick into this player's working Draft deck before any
  // remaining pack enters the exchange queue.
  const pickId = round.pickIds?.[String(myPosition)]
  const lockedPick = [...(cards?.DraftPool ?? [])].find(
    (card) => card?.owner === myPlayerId && card?.id === pickId
  )
  if (!lockedPick) {
    delete round.released[String(myPosition)]
    functions.chatLog("Draft: the locked pick could not be found in Draft Picks.")
    return
  }
  await functions.moveCards([lockedPick], "LimitedStockpile", { noLogs: true })

  const remainingCards = [...(cards?.[sectionName] ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )

  for (const card of remainingCards) {
    await functions.giveCardTo(card, targetPlayerId, "DraftIncoming")
  }

  round.released[String(myPosition)] = "done"
  progress.waitingRound = null
  progress.packPickNumber = Number(progress.packPickNumber ?? 0) + 1

  if (remainingCards.length === 0) {
    progress.activePack = packNumber + 1
    progress.packPickNumber = 0
    if (progress.activePack <= 3) {
      functions.chatLog(
        `Draft: Pack ${packNumber} is complete. Begin Pack ${progress.activePack}.`
      )
    } else {
      functions.chatLog("Draft: all three packs are complete.")
    }
  } else {
    progress.awaitingIncomingPack = packNumber
    functions.chatLog(
      `Draft: all players confirmed; sent ${remainingCards.length} card${remainingCards.length === 1 ? "" : "s"} to seat ${targetPosition + 1}.`
    )
  }

  // Incoming cards wait outside Patrol until this player's original pack has
  // been released, so two packs can never occupy the same Patrol section.
  await btDraftLoadIncomingPack(myPlayerId, progress)
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
  if (progress.waitingRound) {
    const waiting = controller.rounds?.[progress.waitingRound]
    const readyCount = Object.values(waiting?.ready ?? {}).filter(Boolean).length
    functions.chatLog(
      `Draft: your pick is locked. Waiting for the other players (${readyCount}/${totalPlayers} ready).`
    )
    return
  }
  const packNumber = Number(progress.activePack ?? 1)
  const sectionName = BT_DRAFT_PACK_SECTIONS[packNumber]
  if (!sectionName) {
    functions.chatLog("Draft: all three packs are complete.")
    return
  }

  const ownedPicks = [...(cards?.DraftPool ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  const newPickCount = ownedPicks.length
  if (newPickCount !== 1) {
    functions.chatLog(
      newPickCount < 1
        ? `Draft: move exactly one card from Pack ${packNumber} to Draft Picks first.`
        : `Draft: ${newPickCount} unconfirmed cards are in Draft Picks. Return cards until exactly one new pick remains.`
    )
    return
  }

  progress.confirmedPicks = Number(progress.confirmedPicks ?? 0) + 1
  const pickNumber = Number(progress.packPickNumber ?? 0)
  const roundKey = `${packNumber}:${pickNumber}`
  const round = btDraftRound(controller, roundKey, packNumber, pickNumber)
  round.ready = { ...(round.ready ?? {}), [String(myPosition)]: true }
  round.pickIds = {
    ...(round.pickIds ?? {}),
    [String(myPosition)]: ownedPicks[0].id,
  }
  progress.waitingRound = roundKey

  const readyCount = Object.values(round.ready).filter(Boolean).length
  if (readyCount < totalPlayers) {
    functions.chatLog(
      `Draft: pick locked (${readyCount}/${totalPlayers} ready). Waiting for the other players.`
    )
    return
  }

  functions.chatLog("Draft: every player confirmed. Swapping the remaining packs.")
  // Wake every player's onCardsUpdate handler, including the last-card round
  // where there may be no remaining cards to transfer.
  if (functions.repositionCards) await functions.repositionCards()
  await btDraftProcessReadyRounds()
}
