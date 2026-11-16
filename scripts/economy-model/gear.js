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
// game's rule buys next for the main standing in town, among the NPCs of every
// town (the game's gear errand reads all towns' NPC offers): its seller is the
// town's NPC, else the NPC the fewest fare away (Engine.sellerOf). Funded now
// from the adena above reserve, the fare to the seller's town included (our
// choice: the teleport is paid from the same wallet), or null:
// { selfId, slot, price, weapon, town, fare }. The answer reads the wallet, so
// it is not cached; the line's reference body of a level is (it reads only the
// class, level and line).
function npcGear({ snapshot, view }) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const StatsPacket = invoke('GameServer/Bot/Economy/StatsPacket');
    const Templates = invoke('GameServer/Item/ItemTemplateIndex'), DataCache = invoke('GameServer/DataCache');
    const bodies = new Map();
    const bodyOf = (classId, level, line) => {
        const key = `${classId}:${level}:${line}`;
        if (!bodies.has(key)) bodies.set(key, HuntCycle.referenceState(classId, level, { line }));
        return bodies.get(key);
    };
    return {
        next(main, town, reserve) {
            const classId = Table.roleClass(main.line, main.level), body = bodyOf(classId, main.level, Number(main.line));
            const pieces = Object.entries(KitHours.kitInHand(snapshot, main)).filter(([, selfId]) => selfId > 0)
                .map(([slot, selfId]) => ({ slot: Number(slot), selfId: Number(selfId) }));
            const state = { ...body, adena: main.money, inventory: { ...KitHours.inventoryOf(pieces), 57: { selfId: 57, amount: main.money } },
                stats: { ...body.stats, money: StatsPacket.money({ hourAdena: 0, moneyPrice: 0, refillReserve: Math.round(reserve), firstUnfundedPrice: 0 }) } };
            // The NPC that sells the piece: this town's, else the one the fewest fare away (gear has NPC sellers only).
            const sellers = new Map();
            const findNpcOffer = target => {
                const seller = Engine.sellerOf(view, target.selfId, town);
                if (!seller) return null;
                sellers.set(Number(target.selfId), seller);
                return { sourceType: 'npc', price: seller.price, town: seller.town };
            };
            const plan = Planner.staticNpcUpgradePlan(state, { findNpcOffer, buyOrderEscrow: 0 });
            // Funded in the game's terms (npcPurchaseBudget): the price, and here the fare, within the wallet above the reserve.
            const seller = plan?.market ? sellers.get(Number(plan.target.selfId)) : null;
            if (!seller || !(Number(plan.market.price) + seller.fare <= PurchaseFunding.spendable(state, 0, { upperBound: true }))) return null;
            // The plan names the weapon slot (7) for any weapon; a weapon is worn in its own slot (a two-handed one in 14).
            const selfId = Number(plan.target.selfId), weapon = Engine.isWeapon(view.items[selfId]);
            const slot = weapon ? Number(Templates.find(DataCache.items, selfId)?.etc?.slot || plan.target.slot) : Number(plan.target.slot);
            return { selfId, slot, price: Number(plan.market.price), weapon, town: seller.town, fare: seller.fare };
        }
    };
}

module.exports = { npcGear };
