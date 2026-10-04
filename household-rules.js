export function mealSituation(now, userText = '', options = {}) {
  const weekend = now.weekday === 'Sat' || now.weekday === 'Sun';
  const hour = Number(now.hour);
  const meal = hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner';
  const crunch = /10\s*min/i.test(userText) || (meal === 'breakfast' && !weekend);
  const minutes = crunch ? 10 : weekend ? 45 : 25;
  const effort = crunch || !weekend ? 'low' : 'high';
  const cookAvailable = options.cookAvailable !== false;
  return { weekend, meal, minutes, effort, cookAvailable, day: now.weekday };
}

export function applyCartGates(plan, limits = {}) {
  const cartLimit = limits.cartLimit ?? null;
  const weeklyBudget = limits.weeklyBudget ?? null;
  const spent = limits.spent ?? 0;
  const cart = Array.isArray(plan.cart) ? plan.cart : [];
  const missing = Array.isArray(plan.missing) ? plan.missing : [];
  const cartTotal = cart.reduce((sum, line) => sum + (Number(line.estimated_inr) || 0), 0);
  const blocked = missing.filter((item) => item && item.role === 'main' && !item.substitute);
  let humanRequired = Boolean(plan.human_required) || blocked.length > 0;
  let humanReason = plan.human_reason || '';
  if (blocked.length) {
    humanReason = `No substitute for ${blocked.map((item) => item.item).join(', ')}.`;
  }
  if (cartLimit != null && cartTotal > cartLimit) {
    humanRequired = true;
    humanReason = `Cart is ₹${cartTotal}, above the ₹${cartLimit} limit.`;
  }
  if (weeklyBudget != null && spent + cartTotal > weeklyBudget) {
    humanRequired = true;
    humanReason = `This cart would take the week to ₹${spent + cartTotal}, above ₹${weeklyBudget}.`;
  }
  return { cart, missing, cartTotal, cartLimit, weeklyBudget, humanRequired, humanReason };
}
