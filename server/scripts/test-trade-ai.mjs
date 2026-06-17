/**
 * Harness for NP3 (NPC trade AI + distress + market impact). economy._test + npc._test, no DB/manifest/nav.
 * Verifies: player trades still work through the new tradeCore; distress accrues for a starved consumer;
 * chooseTrip dispatches to a distressed town sourced from a producer; an NPC delivery relieves the shortage
 * and conserves gold/treasury; bestSeller/bestBuyer/bestArbitrage behave.
 * Run: node scripts/test-trade-ai.mjs   (from server/)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const economy = require('../economy.js');
const npc = require('../npc.js');

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

const D = { id: 'D', name: 'Distillery', tier: 'small', specialty: 'distillery', x: 0, z: 0 };     // produces rum
const F = { id: 'F', name: 'Forge', tier: 'small', specialty: 'forge', x: 1000, z: 0 };            // consumes rum
economy._test.setTowns([D, F]);
economy._test.seedMarkets();

console.log('(a) player trades still flow through tradeCore (parity):');
const player = { gold: 1000, cargo: {}, state: { vesselSlug: 'sloop' } };
const dStockBefore = economy._test.getMarket('D').stock.rum;
const r = economy.applyBuy(player, { x: 0, z: 0 }, 'D', 'rum', 3);   // docked at D, buy rum (its export)
ok(r.ok && player.cargo.rum === 3 && player.gold < 1000, 'applyBuy: gold down, cargo up');
ok(economy._test.getMarket('D').stock.rum === dStockBefore - 3, 'town stock dropped by the bought qty');
ok(economy.applyBuy(player, { x: 9e5, z: 9e5 }, 'D', 'rum', 1).reason === 'not_docked', 'still rejects an undocked buy');

console.log('(b) distress accrues for a starved consumer:');
economy._test.seedMarkets();
economy._test.tick(60);   // 60 days: the forge consumes rum (+others) with no resupply
const dl = economy.distressList();
console.log(`    distress needs (≥3 days): ${dl.map((d) => `${d.townName}/${d.goodId}:${Math.round(d.distressDays)}`).join(', ') || '(none)'}`);
ok(dl.length > 0, 'distressList surfaces persistent shortages');
ok(dl.some((d) => d.townId === 'F' && d.goodId === 'rum'), "the forge's rum shortage is in distress");
ok(dl.every((d, i) => i === 0 || dl[i - 1].distressDays >= d.distressDays), 'distress list is sorted worst-first');

console.log('(c) dispatch: NEED-driven, sourced from a reachable producer:');
const needs = economy.needList();
console.log(`    needs: ${needs.map((n) => `${n.townName}/${n.goodId}:lvl${n.level}`).join(', ') || '(none)'}`);
ok(needs.length > 0, 'needList surfaces a town short of a consumed good');
ok(needs.some((n) => n.townId === 'F' && n.goodId === 'rum'), "the forge's rum shortage is a need");
const trip = npc._test.chooseTrip();
console.log(`    chosen trip: buy ${trip && trip.goodId} at ${trip && trip.srcTownId} → deliver to ${trip && trip.destTownId}`);
ok(trip && needs.some((n) => n.townId === trip.destTownId && n.goodId === trip.goodId), 'trip destination is a NEEDY town (demand-driven)');
ok(trip && trip.srcTownId !== trip.destTownId, 'sources from a DIFFERENT town');
const seller = economy.bestSellerFor('rum', 'F');
const buyer = economy.bestBuyerFor('rum', 'D');
ok(seller && seller.townId === 'D', 'bestSellerFor(rum) = the distillery (cheapest producer)');
ok(buyer && buyer.townId === 'F', 'bestBuyerFor(rum) = the starved forge (highest bid)');

console.log('(d) an NPC delivery relieves the shortage + conserves value:');
const m = { gold: 1500, cargo: {}, state: { vesselSlug: 'sloop' } };
const Dtreas0 = economy._test.getMarket('D').treasury, Ftreas0 = economy._test.getMarket('F').treasury;
const Frum0 = economy._test.getMarket('F').stock.rum, g0 = m.gold;
let bought = 0; for (let i = 0; i < 8; i++) { if (!economy.npcBuy(m, 'D', 'rum', 1).ok) break; bought++; }
while ((m.cargo.rum || 0) > 0) { if (!economy.npcSell(m, 'F', 'rum', 1).ok) break; }
const Frum1 = economy._test.getMarket('F').stock.rum;
console.log(`    bought ${bought} rum at D, delivered to F; F rum stock ${Math.round(Frum0)} → ${Math.round(Frum1)}; merchant gold ${g0} → ${m.gold}`);
ok(bought > 0, 'merchant bought rum at the producer');
ok(Frum1 > Frum0, "the forge's rum stock rose — the shortage was relieved");
// conservation: merchant Δgold == D paid in (treasury up) − F paid out (treasury down)
const dGold = m.gold - g0, dD = economy._test.getMarket('D').treasury - Dtreas0, dF = economy._test.getMarket('F').treasury - Ftreas0;
ok(Math.abs(dGold - (-dD - dF)) < 1e-6, 'gold conserved: merchant Δ == townD treasury − townF treasury');

console.log('(e) arbitrage fallback exists:');
const arb = economy.bestArbitrage();
ok(arb && arb.margin > 0, 'bestArbitrage finds a positive-margin route');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
