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

// Card moves and ownership transfers fire debounced board-update events. A
// second event must not enter the same async release while the first is still
// banking a pick or passing cards.
let BT_DRAFT_PROCESSING = false
let BT_DRAFT_PROCESS_REQUESTED = false

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
    confirmRequested: false,
    pendingBank: null,
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

async function btDraftRepairStartingPacks() {
  const limited = game?.data?.LimitedController
  const controller = game?.data?.DraftController
  const plans = limited?.packPlans
  if (!controller || !Array.isArray(plans) || plans.length !== 3) {
    functions.chatLog("Draft setup plan is not ready yet. Wait for setup, then click Refresh Seats again.")
    return 0
  }

  const myPlayerId = btDraftFindMyPlayerId()
  if (!myPlayerId) return 0
  const position = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, position)
  const hasLockedPick = [...(cards?.DraftPool ?? [])].some(
    (card) => card?.owner === myPlayerId
  )
  if (
    hasLockedPick ||
    progress.pendingBank ||
    Number(progress.confirmedPicks ?? 0) > 0 ||
    Object.keys(controller.rounds ?? {}).length > 0
  ) {
    return 0
  }

  const repairs = []
  for (const [sectionName, plannedIds] of plans) {
    const currentCards = [...(cards?.[sectionName] ?? [])].filter(
      (card) => card?.owner === myPlayerId || card?.owner === "UNOWNED"
    )
    const missingIds = [...plannedIds]
    for (const card of currentCards) {
      const definitionId = functions.getCardData?.(card)?.id
      const index = missingIds.indexOf(definitionId)
      if (index >= 0) missingIds.splice(index, 1)
    }
    const missingCount = Math.max(0, 15 - currentCards.length)
    for (const cardId of missingIds.slice(0, missingCount)) {
      repairs.push(functions.createCard(cardId, sectionName))
    }
  }

  if (repairs.length > 0) {
    await Promise.all(repairs)
    limited.setupComplete = true
    limited.setupRunning = false
    functions.chatLog(
      `Draft setup repaired ${repairs.length} missing card${repairs.length === 1 ? "" : "s"}.`
    )
  }
  return repairs.length
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
  // Once awaitingIncomingPack is set, this player's original pack has
  // already left Patrol.  Incoming network updates can arrive in pieces, so
  // always drain every currently available card.  Refusing to load because
  // the first arriving card is already in Patrol strands the rest of the
  // pack in DraftIncoming.
  if (incomingCards.length === 0) return false

  await functions.moveCards(incomingCards, sectionName, { noLogs: true })
  // Keep awaitingIncomingPack set until the next pick is confirmed.  That
  // lets later pieces of the same transfer drain into the same Patrol zone.
  return true
}

async function btDraftProcessReadyRounds() {
  // Never discard an update that arrives while a release is already running.
  // Ownership transfers frequently fire onCardsUpdate in the middle of the
  // current async pass. Remember that wake-up and immediately run another
  // pass after the current one finishes so incoming cards cannot remain in
  // the hidden queue until the player touches the board.
  BT_DRAFT_PROCESS_REQUESTED = true
  if (BT_DRAFT_PROCESSING) return
  BT_DRAFT_PROCESSING = true
  try {
    do {
      BT_DRAFT_PROCESS_REQUESTED = false
      await btDraftProcessReadyRoundsUnlocked()
    } while (BT_DRAFT_PROCESS_REQUESTED)
  } finally {
    BT_DRAFT_PROCESSING = false
  }
}

async function btDraftProcessReadyRoundsUnlocked() {
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

  // A seat can only enter round.ready after onCardsUpdate has verified that
  // this exact runtime card is already present in LimitedStockpile.
  const lockedPickId = round.ready?.[String(myPosition)]
  const bankedPick = [...(cards?.LimitedStockpile ?? [])].find(
    (card) => card?.owner === myPlayerId && card?.id === lockedPickId
  )
  if (!bankedPick) {
    delete round.released[String(myPosition)]
    functions.chatLog("Draft: waiting for your selected card to enter your deck.")
    return
  }

  const remainingCards = [...(cards?.[sectionName] ?? [])].filter(
    (card) => card?.owner === myPlayerId && card?.id !== lockedPickId
  )

  // Transfer the remaining pack as one batch of promises.  This minimizes
  // the window in which the receiving client can observe only part of it.
  await Promise.all(
    remainingCards.map((card) =>
      functions.giveCardTo(card, targetPlayerId, "DraftIncoming")
    )
  )

  // Make the completed ownership batch visible to every client's scripting
  // layer. The queued processing guard above safely absorbs this wake-up if
  // it arrives before the current release has returned.
  if (functions.repositionCards) await functions.repositionCards()

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

async function btDraftTryPendingConfirmation() {
  const controller = game?.data?.DraftController
  if (!controller) return
  const position = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, position)
  if (progress.confirmRequested && !progress.pendingBank && !progress.waitingRound) {
    await btDraftConfirmPickAndPass(true)
  }
}

async function btDraftFinalizePendingBank() {
  const controller = game?.data?.DraftController
  if (!controller) return false

  const myPlayerId = await btDraftRegisterPlayer(true)
  if (!myPlayerId) return false
  const totalPlayers = Number(game?.turn?.totalPlayers ?? 0)
  const myPosition = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, myPosition)
  const pending = progress.pendingBank
  if (!pending?.cardId) return false

  const bankedPick = [...(cards?.LimitedStockpile ?? [])].find(
    (card) => card?.owner === myPlayerId && card?.id === pending.cardId
  )
  if (!bankedPick) {
    // The card move can be displayed before the debounced scripting snapshot
    // catches up. If the exact selected instance is visible in any drafting
    // section, retry only its deck move. The round remains unready, so no pack
    // can be released while the pick is outside the deck.
    const misplacedPick = [
      ...(cards?.DraftPool ?? []),
      ...(cards?.Mission ?? []),
      ...(cards?.Mission2 ?? []),
      ...(cards?.Mission3 ?? []),
      ...(cards?.DraftIncoming ?? []),
    ].find(
      (card) => card?.owner === myPlayerId && card?.id === pending.cardId
    )
    if (misplacedPick) {
      // Do not update and then move the same card object. An awaited update can
      // replace the runtime object and leave the following move with a stale
      // reference. A single moveCard call is the entire retry transaction.
      await functions.moveCard(misplacedPick, "LimitedStockpile", { noLogs: true })
    }
    return false
  }

  // The section itself is opponent-hidden. Set the explicit card state only
  // after a fresh snapshot proves that the card is already in the deck.
  if (bankedPick.isHidden !== "yes") {
    await functions.updateCards([bankedPick], { isHidden: "yes" })
  }

  const packNumber = Number(pending.packNumber)
  const pickNumber = Number(pending.pickNumber)
  const roundKey = `${packNumber}:${pickNumber}`
  const round = btDraftRound(controller, roundKey, packNumber, pickNumber)
  round.ready = {
    ...(round.ready ?? {}),
    [String(myPosition)]: pending.cardId,
  }
  progress.pendingBank = null
  progress.confirmedPicks = Number(progress.confirmedPicks ?? 0) + 1
  progress.waitingRound = roundKey

  const readyCount = Object.values(round.ready).filter(Boolean).length
  if (readyCount < totalPlayers) {
    functions.chatLog(
      `Draft: pick banked and locked (${readyCount}/${totalPlayers} ready). Waiting for the other players.`
    )
    return true
  }

  functions.chatLog("Draft: every pick is banked. Swapping the remaining packs.")
  if (functions.repositionCards) await functions.repositionCards()
  await btDraftProcessReadyRounds()
  return true
}

async function btDraftConfirmPickAndPass(fromCardUpdate = false) {
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
  if (progress.pendingBank) {
    functions.chatLog("Draft: waiting for your selected card to enter your deck.")
    return
  }
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

  // Any delayed pieces from the previous pass have now had a chance to load.
  // Stop treating new DraftIncoming cards as part of that completed pass once
  // the player starts confirming the next pick.
  await btDraftLoadIncomingPack(myPlayerId, progress)
  progress.awaitingIncomingPack = null

  const ownedPicks = [...(cards?.DraftPool ?? [])].filter(
    (card) => card?.owner === myPlayerId
  )
  const newPickCount = ownedPicks.length
  if (newPickCount !== 1) {
    if (newPickCount < 1) {
      // The drag can render before the debounced cards snapshot updates. Keep
      // the request queued; onCardsUpdate will confirm the exact card once it
      // is visible to scripting.
      progress.confirmRequested = true
      if (!fromCardUpdate) {
        functions.chatLog(
          `Draft: Pack ${packNumber} pick is syncing; confirmation will complete automatically.`
        )
      }
      return
    }
    progress.confirmRequested = false
    functions.chatLog(
      `Draft: ${newPickCount} unconfirmed cards are in Draft Picks. Return cards until exactly one new pick remains.`
    )
    return
  }

  progress.confirmRequested = false
  const pickNumber = Number(progress.packPickNumber ?? 0)
  const selectedPick = ownedPicks[0]
  progress.pendingBank = {
    cardId: selectedPick.id,
    packNumber,
    pickNumber,
  }
  // One atomic single-card move. Hiding is applied from a fresh deck snapshot
  // in btDraftFinalizePendingBank, never to this pre-move card reference.
  await functions.moveCard(selectedPick, "LimitedStockpile", { noLogs: true })
  functions.chatLog("Draft: banking your selected card before the pack can pass.")
  // This is the final board operation in the confirmation transaction. It
  // guarantees a fresh debounced snapshot even if the move did not otherwise
  // wake this client immediately.
  if (functions.repositionCards) await functions.repositionCards()
}
