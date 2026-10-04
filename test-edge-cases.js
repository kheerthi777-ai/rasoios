import { runOrchestration } from './orchestrator-hitl.js';

async function testCases() {
  console.log('--- TEST 1: Stockout with Zero Substitutions (HITL Escalation) ---');
  // Pasta requires macaroni, which is NOT in the database and has no substitutes
  const failedDish = {
    name: 'Kids Macaroni Pasta',
    prepTimeMinutes: 20,
    cookInstructionsHindi: 'पास्ता उबालें और सॉस में मिलाएं।',
    ingredients: [
      { id: 'macaroni_pasta', needed: 200, unit: 'g' },
      { id: 'cheese_slices', needed: 2, unit: 'slices' }
    ]
  };
  await runOrchestration({ dishCandidate: failedDish, estimatedCartTotal: 0, cookAvailable: true });

  console.log('\n--- TEST 2: Budget Gate Breach (HITL Escalation) ---');
  // Dish is viable (using in-stock Upma items), but simulated cart exceeds ₹300 limit
  const upmaDish = {
    name: 'Vegetable Rava Upma',
    prepTimeMinutes: 15,
    cookInstructionsHindi: 'रवा भूनें और सब्जियों के साथ पकाएं।',
    ingredients: [
      { id: 'rava', needed: 250, unit: 'g' },
      { id: 'matar_fresh', needed: 100, unit: 'g' }
    ]
  };
  await runOrchestration({ dishCandidate: upmaDish, estimatedCartTotal: 450, cookAvailable: true });
}

testCases().then(() => process.exit(0)).catch(console.error);
