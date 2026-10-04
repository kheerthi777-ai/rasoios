import assert from 'node:assert/strict';
import { applyCartGates, mealSituation, planFromStock } from './household-rules.js';

const mondayMorning = { weekday: 'Mon', hour: '08', minute: '00' };
const sundayLunch = { weekday: 'Sun', hour: '14', minute: '00' };

const breakfast = mealSituation(mondayMorning);
assert.equal(breakfast.meal, 'breakfast');
assert.equal(breakfast.effort, 'low');
assert.equal(breakfast.minutes, 10);
assert.equal(breakfast.weekend, false);

const weekend = mealSituation(sundayLunch);
assert.equal(weekend.meal, 'lunch');
assert.equal(weekend.effort, 'high');
assert.equal(weekend.minutes, 45);
assert.equal(weekend.weekend, true);

const crunch = mealSituation(sundayLunch, 'need this in 10 min');
assert.equal(crunch.minutes, 10);
assert.equal(crunch.effort, 'low');

const off = mealSituation(mondayMorning, '', { cookAvailable: false });
assert.equal(off.cookAvailable, false);

const underLimit = applyCartGates({ cart: [{ estimated_inr: 80 }], missing: [] });
assert.equal(underLimit.humanRequired, false);
assert.equal(underLimit.cartTotal, 80);

const overCart = applyCartGates({ cart: [{ estimated_inr: 450 }], missing: [] });
assert.equal(overCart.humanRequired, true);
assert.match(overCart.humanReason, /300/);

const overWeek = applyCartGates(
  { cart: [{ estimated_inr: 200 }], missing: [] },
  { spent: 1900, weeklyBudget: 2000, cartLimit: 300 }
);
assert.equal(overWeek.humanRequired, true);
assert.match(overWeek.humanReason, /2000/);

const noSubstitute = applyCartGates({
  cart: [],
  missing: [{ item: 'pasta', role: 'main', substitute: null }]
});
assert.equal(noSubstitute.humanRequired, true);
assert.match(noSubstitute.humanReason, /pasta/);

const skippedGarnish = applyCartGates({
  cart: [],
  missing: [{ item: 'kothmir', role: 'garnish', substitute: 'skip' }]
});
assert.equal(skippedGarnish.humanRequired, false);

const stock = [
  { name: 'Fresh Fermented Batter', quantity: 800, unit: 'g', usable_today: true },
  { name: 'Fresh Coconut Chutney (Yesterday)', quantity: 100, unit: 'g', usable_today: true },
  { name: 'Cooked Tur Dal Tadka', quantity: 1.5, unit: 'katori', usable_today: true },
  { name: 'Fresh Kothmir / Dhania', quantity: 0, unit: 'g', usable_today: false },
  { name: 'Fresh Malai Paneer', quantity: 0, unit: 'g', usable_today: false },
  { name: 'Wada Kolam Rice', quantity: 10, unit: 'kg', usable_today: true },
  { name: 'Wibs Brown Bread', quantity: 4, unit: 'piece', usable_today: true },
  { name: 'Amul Cheese Slices', quantity: 2, unit: 'piece', usable_today: true }
];

const quick = planFromStock(stock, breakfast, 'light');
assert.match(quick.family_text, /batter/i);
assert.match(quick.kids_text, /no chilli/i);
assert.match(quick.cook_text_hi, /इडली/);
assert.equal(quick.human_required, false);
assert.equal(quick.cart.length, 0);
assert.equal(quick.missing.some((item) => item.item === 'kothmir' && item.substitute === 'skip'), true);

const naniOff = planFromStock(stock, { ...breakfast, cookAvailable: false }, null);
assert.match(naniOff.cook_text_hi, /उपलब्ध नहीं/);

const pasta = planFromStock(stock, weekend, null, 'make pasta');
assert.equal(pasta.human_required, true);
assert.equal(pasta.missing.some((item) => item.item === 'pasta' && item.substitute === null), true);

console.log('household rules ok');
