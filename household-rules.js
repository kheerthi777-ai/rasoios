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
  const cartLimit = limits.cartLimit ?? 300;
  const weeklyBudget = limits.weeklyBudget ?? 2000;
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
  if (cartTotal > cartLimit) {
    humanRequired = true;
    humanReason = `Cart is ₹${cartTotal}, above the ₹${cartLimit} limit.`;
  }
  if (spent + cartTotal > weeklyBudget) {
    humanRequired = true;
    humanReason = `This cart would take the week to ₹${spent + cartTotal}, above ₹${weeklyBudget}.`;
  }
  return { cart, missing, cartTotal, cartLimit, weeklyBudget, humanRequired, humanReason };
}

function usable(stock) {
  return stock.filter((item) => item.usable_today !== false && Number(item.quantity) > 0);
}

function findItem(stock, pattern) {
  return stock.find((item) => pattern.test(item.name));
}

export function planFromStock(stock, situation, mood, userText = '') {
  const items = usable(stock);
  const batter = findItem(items, /batter/i);
  const chutney = findItem(items, /chutney/i);
  const dal = findItem(items, /dal tadka/i);
  const bread = findItem(items, /bread/i);
  const cheese = findItem(items, /cheese/i);
  const rice = findItem(items, /rice/i);
  const pasta = findItem(items, /macaroni|pasta/i);
  const wantsPasta = /pasta|macaroni/i.test(userText);
  const missing = [];
  const cart = [];
  let humanRequired = false;
  let humanReason = '';

  if (wantsPasta && !pasta) {
    missing.push({ item: 'pasta', role: 'main', substitute: null });
    humanRequired = true;
    humanReason = 'No pasta is in the house, and no pasta substitute is available to order.';
  }

  const kothmir = findItem(stock, /kothmir|coriander/i);
  if (!kothmir || Number(kothmir.quantity) === 0 || kothmir.usable_today === false) {
    missing.push({ item: 'kothmir', role: 'garnish', substitute: 'skip' });
  }

  let familyText;
  let kidsText;
  let cookText;
  if (humanRequired) {
    familyText = 'Pasta was asked for, and there is no pasta in the house.';
    kidsText = 'Keep the children on idli or dal and rice until a person chooses a substitute.';
    cookText = 'पास्ता नहीं है। इंतज़ार करो।';
  } else if (situation.minutes <= 10 && batter) {
    familyText = `Make idli or dosa from ${batter.quantity} ${batter.unit} batter${chutney ? ` with ${chutney.quantity} ${chutney.unit} chutney` : ''}${dal ? ` and the leftover dal` : ''}.`;
    kidsText = 'Plain idli for the kids, with no chilli.';
    cookText = 'बैटर से इडली बनाओ। बच्चों को बिना मिर्च दो। चटनी साथ में दो।';
  } else if (dal && rice) {
    familyText = `Serve ${rice.name} with the leftover ${dal.name}. ${bread && cheese ? `A firm cheese toast is the second plate.` : ''}`;
    kidsText = 'Children get dal and rice, less spicy than the adults.';
    cookText = 'दाल गरम करो। चावल पकाओ। बच्चों की दाल में मिर्च कम रखो।';
  } else if (bread && cheese) {
    familyText = 'Make a firm cheese toast from the bread and cheese.';
    kidsText = 'Cheese toast for the kids, no chilli.';
    cookText = 'ब्रेड को कुरकुरा टोस्ट करो। चीज़ रखो। कच्ची प्याज़ मत डालो।';
  } else {
    familyText = 'The stock does not support a full meal without a person choosing.';
    kidsText = '';
    cookText = 'आज का खाना परिवार तय करेगा।';
    humanRequired = true;
    humanReason = 'Nothing in the stock can make a meal.';
  }

  if (!situation.cookAvailable) {
    cookText = `नानी आज उपलब्ध नहीं हैं। परिवार ये कदम खुद करे: ${cookText}`;
  }
  if (mood) familyText = `${familyText} Mood is ${mood}.`;

  return {
    family_text: familyText.trim(),
    kids_text: kidsText,
    cook_text_hi: cookText,
    missing,
    cart,
    human_required: humanRequired,
    human_reason: humanReason
  };
}
