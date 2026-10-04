import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js']
});

const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

async function run() {
  await client.connect(transport);
  console.log('✓ Connected to MCP Server via STDIO');

  // 1. List tools
  const tools = await client.listTools();
  console.log('\nRegistered Tools:', tools.tools.map(t => t.name));

  // 2. Call get_taste_profile_context
  console.log('\n--- Calling: get_taste_profile_context ---');
  const tasteRes = await client.callTool({
    name: 'get_taste_profile_context',
    arguments: { dish_query: 'grilled cheese toast' }
  });
  console.log(tasteRes.content[0].text);

  // 3. Call check_pantry_inventory
  console.log('\n--- Calling: check_pantry_inventory ---');
  const invRes = await client.callTool({
    name: 'check_pantry_inventory',
    arguments: { required_skus: ['Fresh Paneer 200g', 'Green Peas 250g'] }
  });
  console.log(invRes.content[0].text);

  process.exit(0);
}

run().catch(err => {
  console.error('Client test failed:', err);
  process.exit(1);
});
