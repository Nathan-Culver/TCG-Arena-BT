BattleTech TCG for TCG Arena
================================

Files
-----
Game_BattleTech.json
BattleTech_CardList.json
BattleTech-back.png

Catalog
-------
Cards: 1438
Cards with public scan URLs: 1438
Cards with rarity metadata: 1438
Page-fetch failures: 0

Notes
-----
- The layout follows the published regions: Stockpile, Construction Region,
  Command Post, Patrol Region, hand, and Scrapheap, with a Mission/Battle area.
- Setup draws 5 cards. Each turn draws 2 cards.
- Each card includes these normalized characteristics:
  cardName, secondaryName, constructionCost, assets, assetCosts, alignment,
  affiliation, unitData, keywords, options, speed, attack, armor, and structure.
- Alignment is always Clan, Inner Sphere, or Universal.
- Assets and assetCosts are parsed from construction requirements. Supported
  assets are Assembly, Logistics, Munitions, Politics, and Tactics.
- unitData contains mass and armament where applicable.
- options includes printed options and full text abilities, excluding flavor text.
- Card catalog metadata and scans link to the public Sarna BattleTechWiki.
- TCG Arena is a manual simulator; card effects are not scripted.
