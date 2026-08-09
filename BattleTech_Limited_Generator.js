"use strict";

const GAME_NAME = "BattleTech Trading Card Game";
const IMPORT_BASE = "https://tcg-arena.fr/import";
const SETUP_CARD_NAME = "Limited Format Setup Card";
const SETS = [
  ["Limited", "Limited"],
  ["Unlimited", "Unlimited"],
  ["Counterstrike", "Counterstrike"],
  ["Mercenaries", "Mercenaries"],
  ["MechWarrior", "MechWarrior"],
  ["Arsenal", "Arsenal"],
  ["CommandersEdition", "Commander's Edition"],
  ["Crusade", "Crusade"],
];

const formatEl = document.querySelector("#format");
const setsEl = document.querySelector("#sets");
const seedEl = document.querySelector("#seed");
const generateEl = document.querySelector("#generate");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const packsEl = document.querySelector("#packs");
const importEl = document.querySelector("#import");
const copyEl = document.querySelector("#copy");
const downloadEl = document.querySelector("#download");
const workflowEl = document.querySelector("#workflow");
const limitationEl = document.querySelector("#limitation");

let cards = [];
let currentDeckList = "";

function packCount() {
  return formatEl.value === "Draft" ? 3 : 6;
}

function rebuildSetSelectors() {
  const previous = [...setsEl.querySelectorAll("select")].map((item) => item.value);
  setsEl.replaceChildren();
  for (let index = 0; index < packCount(); index += 1) {
    const label = document.createElement("label");
    label.textContent = `Pack ${index + 1}`;
    const select = document.createElement("select");
    select.dataset.pack = String(index + 1);
    for (const [value, shown] of SETS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = shown;
      select.append(option);
    }
    select.value = previous[index] || SETS[0][0];
    label.append(select);
    setsEl.append(label);
  }
}

function xmur3(text) {
  let hash = 1779033703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return function nextHash() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

function mulberry32(seed) {
  return function random() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function takeRandom(pool, count, random) {
  if (!pool.length) throw new Error("A required rarity has no cards in this set.");
  const available = [...pool];
  const selected = [];
  while (selected.length < count) {
    if (!available.length) available.push(...pool);
    const index = Math.floor(random() * available.length);
    selected.push(available.splice(index, 1)[0]);
  }
  return selected;
}

function makePack(setName, random) {
  const setCards = cards.filter((card) => card.set === setName);
  const rarity = (name) => setCards.filter((card) => card.rarity === name);
  let pack;
  if (setName === "Limited" || setName === "Unlimited") {
    pack = [
      ...takeRandom(rarity("Rare"), 1, random),
      ...takeRandom(rarity("Vital"), 2, random),
      ...takeRandom(rarity("Uncommon"), 3, random),
      ...takeRandom(rarity("Common"), 9, random),
    ];
  } else {
    pack = [
      ...takeRandom(rarity("Rare"), 1, random),
      ...takeRandom(rarity("Uncommon"), 3, random),
      ...takeRandom(rarity("Common"), 11, random),
    ];
  }
  return pack;
}

function latin1Base64(text) {
  for (const character of text) {
    if (character.codePointAt(0) > 255) {
      throw new Error(`Cannot encode card name character: ${character}`);
    }
  }
  return btoa(text);
}

function buildDeckList(format, packs) {
  const lines = [`1 ${SETUP_CARD_NAME}`, ""];
  packs.forEach((pack, index) => {
    lines.push(`${format} Pack ${index + 1}:`);
    const counts = new Map();
    for (const card of pack) counts.set(card.name, (counts.get(card.name) || 0) + 1);
    for (const [name, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`${count} ${name}`);
    }
    if (index < packs.length - 1) lines.push("");
  });
  return lines.join("\n");
}

function buildImportUrl(format, seed, deckList) {
  const params = new URLSearchParams({
    game: GAME_NAME,
    id: `limited-${format.toLowerCase()}-${seed}`,
    name: `BattleTech ${format} — ${seed}`,
    deck: latin1Base64(deckList),
  });
  return `${IMPORT_BASE}?${params.toString()}`;
}

function showPacks(selectedSets, packs) {
  packsEl.replaceChildren();
  packs.forEach((pack, index) => {
    const section = document.createElement("section");
    section.className = "panel pack";
    const heading = document.createElement("h2");
    const shownSet = SETS.find(([value]) => value === selectedSets[index])?.[1];
    heading.textContent = `Pack ${index + 1} — ${shownSet}`;
    const list = document.createElement("ol");
    for (const card of pack) {
      const item = document.createElement("li");
      item.textContent = card.name;
      const rarity = document.createElement("span");
      rarity.className = "rarity";
      rarity.textContent = card.rarity;
      item.append(rarity);
      list.append(item);
    }
    section.append(heading, list);
    packsEl.append(section);
  });
}

function showWorkflow(format) {
  const steps = format === "Draft"
    ? [
        "Match each shared setup-panel selection to the packs generated here.",
        "Open Pack 1 into the Shared Draft Zone. Pick one card and move it to your private Draft Pool.",
        "Use Give Card to pass the remaining pack. Continue until empty; alternate passing direction for Packs 2 and 3.",
        "Move the cards for your finished deck from Draft Pool to Stockpile, shuffle, then open the delayed mulligan panel.",
      ]
    : [
        "Match the six shared setup-panel selections to the packs generated here.",
        "Open each pile and move its cards into your private Sealed Pool.",
        "Move the cards for your finished deck from Sealed Pool to Stockpile; leave unused cards outside the Stockpile.",
        "Shuffle the Stockpile, then open the delayed mulligan panel.",
      ];
  workflowEl.replaceChildren(...steps.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  limitationEl.textContent = format === "Draft"
    ? "TCG-Arena does not generate or pass packs automatically. Use the visible Shared Draft Zone and the native Give Card action when passing a pack. Set selections are recorded in the shared setup panel."
    : "TCG-Arena does not generate packs automatically. Open each imported pack pile into your private Sealed Pool after recording the six choices in the shared setup panel.";
}

function generate() {
  try {
    const format = formatEl.value;
    const selectedSets = [...setsEl.querySelectorAll("select")].map((item) => item.value);
    const seed = seedEl.value.trim() || crypto.getRandomValues(new Uint32Array(2)).join("-");
    seedEl.value = seed;
    const seedHash = xmur3(`${format}|${seed}|${selectedSets.join("|")}`);
    const random = mulberry32(seedHash());
    const packs = selectedSets.map((setName) => makePack(setName, random));
    currentDeckList = buildDeckList(format, packs);
    importEl.href = buildImportUrl(format, seed, currentDeckList);
    showPacks(selectedSets, packs);
    showWorkflow(format);
    resultEl.hidden = false;
    statusEl.textContent = `Generated ${packs.length} packs (${packs.length * 15} cards) with seed ${seed}.`;
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  }
}

formatEl.addEventListener("change", () => {
  rebuildSetSelectors();
  resultEl.hidden = true;
});
generateEl.addEventListener("click", generate);
copyEl.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentDeckList);
  copyEl.textContent = "Copied";
  setTimeout(() => { copyEl.textContent = "Copy deck list"; }, 1200);
});
downloadEl.addEventListener("click", () => {
  const blob = new Blob([currentDeckList], { type: "text/plain;charset=iso-8859-1" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `BattleTech_${formatEl.value}_Packs.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
});

rebuildSetSelectors();
fetch("BattleTech_CardList.json")
  .then((response) => {
    if (!response.ok) throw new Error(`Card list returned HTTP ${response.status}`);
    return response.json();
  })
  .then((data) => {
    cards = Object.values(data).filter((card) => card.set !== "Promo" && card.set !== "System");
    generateEl.disabled = false;
    generateEl.textContent = "Generate packs";
    statusEl.textContent = `Loaded ${cards.length} cards from ${SETS.length} booster sets.`;
  })
  .catch((error) => {
    statusEl.textContent = `Unable to load BattleTech_CardList.json: ${error.message}. Host this file beside the generator.`;
  });
