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
const BT_DRAFT_MAX_SEATS = 4

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
  if (controller.activePack == null) controller.activePack = 1
  if (controller.confirmedPicks == null) controller.confirmedPicks = 0
  if (controller.packPickNumber == null) controller.packPickNumber = 0
  if (controller.waitingRound == null) controller.waitingRound = null
  if (controller.awaitingIncomingPack == null) controller.awaitingIncomingPack = null
  if (controller.confirmRequested == null) controller.confirmRequested = false
  if (!Array.isArray(controller.pendingHideIds)) controller.pendingHideIds = []
  if (controller.registeredCount == null) controller.registeredCount = 0
  return controller
}

function btDraftSeatChannel(position) {
  return game?.data?.[`DraftSeat${Number(position) + 1}`]
}

function btDraftSeatChannels(totalPlayers = Number(game?.turn?.totalPlayers ?? 0)) {
  return Array.from(
    { length: Math.min(BT_DRAFT_MAX_SEATS, totalPlayers) },
    (_, position) => btDraftSeatChannel(position)
  )
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
    Number(progress.confirmedPicks ?? 0) > 0 ||
    progress.waitingRound
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
  const seat = btDraftSeatChannel(position)
  if (!seat) return undefined
  seat.playerId = playerId
  btDraftSeatProgress(controller, position)
  controller.registeredCount = btDraftSeatChannels().filter(
    (channel) => channel?.playerId
  ).length
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

  const seatChannels = btDraftSeatChannels(totalPlayers)
  const readyCount = seatChannels.filter(
    (seat) => seat?.readyRound === roundKey && seat?.readyCardId
  ).length
  if (readyCount < totalPlayers) return
  const mySeat = btDraftSeatChannel(myPosition)
  if (!mySeat) return
  if (mySeat.releasedRound === roundKey || mySeat.releasingRound === roundKey) return

  const [packValue] = String(roundKey).split(":")
  const packNumber = Number(packValue)
  const sectionName = BT_DRAFT_PACK_SECTIONS[packNumber]
  if (!sectionName) return

  const direction = packNumber === 2 ? -1 : 1
  const targetPosition = (myPosition + direction + totalPlayers) % totalPlayers
  const targetPlayerId = btDraftSeatChannel(targetPosition)?.playerId
  if (!targetPlayerId) {
    functions.chatLog(
      `Draft: seat ${targetPosition + 1} is not registered. Every player should click Refresh Seats once.`
    )
    return
  }

  // Set the guard before transferring because every transferred card can fire
  // another onCardsUpdate event.
  mySeat.releasingRound = roundKey

  const lockedPickId = mySeat.readyCardId
  const lockedPick = [...(cards?.DraftPool ?? [])].find(
    (card) => card?.owner === myPlayerId && card?.id === lockedPickId
  )
  const alreadyBanked = [...(cards?.LimitedStockpile ?? [])].some(
    (card) => card?.owner === myPlayerId && card?.id === lockedPickId
  )
  if (lockedPick) {
    // Every seat has confirmed. Bank this exact selected card and await the
    // move before releasing any card from the remaining pack.
    await functions.moveCard(lockedPick, "LimitedStockpile", { noLogs: true })
    progress.pendingHideIds = [
      ...new Set([...(progress.pendingHideIds ?? []), lockedPickId]),
    ]
  } else if (!alreadyBanked) {
    mySeat.releasingRound = null
    functions.chatLog("Draft: the confirmed pick could not be found in Draft Picks.")
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

  mySeat.releasingRound = null
  mySeat.releasedRound = roundKey
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
  if (progress.confirmRequested && !progress.waitingRound) {
    await btDraftConfirmPickAndPass(true)
  }
}

async function btDraftHideBankedPicks() {
  const controller = game?.data?.DraftController
  if (!controller) return false

  const myPlayerId = btDraftFindMyPlayerId()
  if (!myPlayerId) return false
  const myPosition = Number(game?.turn?.orderPosition ?? 0)
  const progress = btDraftSeatProgress(controller, myPosition)
  const pendingIds = new Set(progress.pendingHideIds ?? [])
  if (pendingIds.size === 0) return false
  const found = [...(cards?.LimitedStockpile ?? [])].filter(
    (card) => card?.owner === myPlayerId && pendingIds.has(card.id)
  )
  if (found.length === 0) return false
  await functions.updateCards(found, { isHidden: "yes" })
  const foundIds = new Set(found.map((card) => card.id))
  progress.pendingHideIds = [...pendingIds].filter((id) => !foundIds.has(id))
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
  if (progress.waitingRound) {
    const readyCount = btDraftSeatChannels(totalPlayers).filter(
      (seat) =>
        seat?.readyRound === progress.waitingRound && seat?.readyCardId
    ).length
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
  const roundKey = `${packNumber}:${pickNumber}`
  const selectedPick = ownedPicks[0]
  const mySeat = btDraftSeatChannel(myPosition)
  if (!mySeat) return
  mySeat.readyRound = roundKey
  mySeat.readyCardId = selectedPick.id
  progress.confirmedPicks = Number(progress.confirmedPicks ?? 0) + 1
  progress.waitingRound = roundKey

  const readyCount = btDraftSeatChannels(totalPlayers).filter(
    (seat) => seat?.readyRound === roundKey && seat?.readyCardId
  ).length
  if (readyCount < totalPlayers) {
    functions.chatLog(
      `Draft: pick locked (${readyCount}/${totalPlayers} ready). Waiting for the other players.`
    )
    return
  }

  functions.chatLog("Draft: every player confirmed. Banking picks and swapping packs.")
  if (functions.repositionCards) await functions.repositionCards()
  await btDraftProcessReadyRounds()
}
