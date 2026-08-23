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

/*
 * The current TCG-Arena client can reach initialBoardSetup before very large
 * categoriesAlreadyOnBoard piles have finished loading. Drawing from those
 * piles at that moment silently does nothing. This routine runs after setup
 * and retries on the next card update until every source pile is available.
 */
async function btLimitedSetup(kind, setKey) {
  const controller = game?.data?.LimitedController
  if (!controller || controller.setupComplete || controller.setupRunning) return
  if (Number(game?.turn?.count ?? 0) < 1) return

  const isSealed = kind === "Sealed"
  const prefix = `${kind}${setKey}`
  const jobs = []
  const requirements = []

  if (isSealed) {
    const rareSource = `${prefix}RareSource`
    const randomSource = `${prefix}RandomSource`
    const destinations = [
      "Mission",
      "Mission2",
      "Mission3",
      "CommandPost",
      "CommandPost2",
      "CommandPost3",
    ]
    requirements.push([rareSource, 12], [randomSource, 78])
    for (const destination of destinations) {
      jobs.push([[[rareSource, 2], [randomSource, 13]], destination])
    }
  } else {
    for (let slot = 1; slot <= 3; slot += 1) {
      const rareSource = `${prefix}Pack${slot}RareSource`
      const randomSource = `${prefix}Pack${slot}RandomSource`
      const destination = slot === 1 ? "Mission" : `Mission${slot}`
      requirements.push([rareSource, 4], [randomSource, 11])
      jobs.push([[[rareSource, 4], [randomSource, 11]], destination])
    }
  }

  const resourceSource = `${prefix}BasicResources`
  requirements.push([resourceSource, 100])

  const sourcesReady = requirements.every(
    ([source, count]) => (cards?.[source]?.length ?? 0) >= count
  )
  if (!sourcesReady) {
    controller.attempts = Number(controller.attempts ?? 0) + 1
    return
  }

  controller.setupRunning = true
  try {
    const shuffledSources = {}
    for (const [source] of requirements) {
      const pool = [...(cards?.[source] ?? [])]
      for (let index = pool.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1))
        ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
      }
      shuffledSources[source] = pool
    }

    for (const [parts, destination] of jobs) {
      const pack = []
      for (const [source, count] of parts) {
        pack.push(...shuffledSources[source].splice(0, count))
      }
      await functions.moveCards(pack, destination, { noLogs: true })
    }
    const resources = shuffledSources[resourceSource].splice(0, 100)
    await functions.moveCards(resources, "Discard", { noLogs: true })
    controller.setupComplete = true
    functions.chatLog(
      isSealed
        ? "Limited setup: six sealed packs and basic resources are ready."
        : "Limited setup: three draft packs and basic resources are ready."
    )
  } finally {
    controller.setupRunning = false
  }
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
