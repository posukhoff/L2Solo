'use strict';

// The design bot's gear purchase at a town visit, by the game's rule for an
// NPC world (GearAcquisitionPlanner.staticNpcUpgradePlan, the first source
// the game's gear plan tries): nothing below the gear focus level; the
// adequate kit first, slot by slot in the game's order, the cheapest
// suitable NPC piece at the highest grade the level takes (D from 20), an
// unfunded weapon not blocking affordable armour; then, at no-grade and D
// levels, improvements by gain over price. It reads the main's worn kit and
// wallet through the game's reference body of its line and level; the
// money it keeps is the reserve the caller names (the game's refill reserve
// in the money packet). Called by the design plane in a town chain after its
// sales. Needs Boot.boot() (the game's catalog and planner).
const Engine = require('./engine');
const KitHours = require('./kit-hours');

// npcGear({ snapshot, view }) -> { next(main, town, reserve) }: the piece the
// game's rule buys next for the main in town, funded now from the adena above
// reserve, or null: { selfId, slot, price, weapon }. No cache: the answer
// reads the wallet.
function npcGear({ snapshot, view }) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const StatsPacket = invoke('GameServer/Bot/Economy/StatsPacket');
    const Templates = invoke('GameServer/Item/ItemTemplateIndex'), DataCache = invoke('GameServer/DataCache');
    return {
        next(main, town, reserve) {
            const classId = Table.roleClass(main.line, main.level), body = HuntCycle.referenceState(classId, main.level, { line: Number(main.line) });
            const pieces = Object.entries(KitHours.kitInHand(snapshot, main)).filter(([, selfId]) => selfId > 0)
                .map(([slot, selfId]) => ({ slot: Number(slot), selfId: Number(selfId) }));
            const state = { ...body, adena: main.money, inventory: { ...KitHours.inventoryOf(pieces), 57: { selfId: 57, amount: main.money } },
                stats: { ...body.stats, money: StatsPacket.money({ hourAdena: 0, moneyPrice: 0, refillReserve: Math.round(reserve), firstUnfundedPrice: 0 }) } };
            // The NPC of this town that sells the piece, at its price.
            const findNpcOffer = target => {
                const row = (view.offers.get(Number(target.selfId)) || []).find(each => each.channel === 'npc_buy' && each.town === town);
                return row ? { sourceType: 'npc', price: row.price, town } : null;
            };
            const plan = Planner.staticNpcUpgradePlan(state, { findNpcOffer, buyOrderEscrow: 0 });
            // Funded in the game's terms (npcPurchaseBudget): the price within the wallet above the reserve.
            if (!plan?.market || !(Number(plan.market.price) <= PurchaseFunding.spendable(state, 0, { upperBound: true }))) return null;
            // The plan names the weapon slot (7) for any weapon; a weapon is worn in its own slot (a two-handed one in 14).
            const selfId = Number(plan.target.selfId), weapon = Engine.isWeapon(view.items[selfId]);
            const slot = weapon ? Number(Templates.find(DataCache.items, selfId)?.etc?.slot || plan.target.slot) : Number(plan.target.slot);
            return { selfId, slot, price: Number(plan.market.price), weapon };
        }
    };
}

module.exports = { npcGear };
