import { rasoiApp } from './src/graph/rasoi_graph.js';

async function main() {
  console.log('🚀 Starting RasoiOS LangGraph Agentic Org...');
  
  const finalState = await rasoiApp.invoke({
    mealType: 'Sunday Lunch',
    userRequest: 'Traditional South Indian lunch with whatever lentils and vegetables we have in the fridge.'
  });

  console.log('\n=============================================');
  console.log('🎉 Execution Finished Successfully!');
  console.log('Dish Planned:', finalState.selectedMeal?.dish_name);
  console.log('Hindi Brief:', finalState.cookInstructionsHindi);
  console.log('Budget Status:', finalState.budgetApproved ? 'Approved' : 'HITL Required');
  console.log('=============================================');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal Graph Error:', err);
  process.exit(1);
});
