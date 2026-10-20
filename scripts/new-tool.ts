/**
 * scripts/new-tool.ts
 *
 * Scaffolding generator for creating new Nodal AI tools and their corresponding
 * test suites. Ensures new tools adhere to architectural patterns, Zod validation,
 * and error handling.
 *
 * Usage:
 *   npx ts-node scripts/new-tool.ts <ToolName>
 *   npm run new-tool <ToolName>
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function toPascalCase(str: string): string {
  const clean = str.replace(/Tool$/i, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function generateToolCode(pascalName: string, snakeName: string): string {
  return `/**
 * backend/tools/${pascalName}Tool.ts
 *
 * Tool for executing \`${snakeName}\` tasks.
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger';

const logger = createLogger('${snakeName}');

export const ${pascalName}ParamsSchema = z.object({
  destination: z.string().min(1, 'Destination is required'),
  description: z.string().optional(),
});

export type ${pascalName}Params = z.infer<typeof ${pascalName}ParamsSchema>;

export class ${pascalName}Tool {
  /**
   * Execute the ${snakeName} task.
   */
  async execute(params: ${pascalName}Params): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const validated = ${pascalName}ParamsSchema.parse(params);
    logger.info('Executing ${snakeName} task', { destination: validated.destination });

    // Implementation logic here
    return {
      success: true,
      data: {
        destination: validated.destination,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
`;
}

function generateTestCode(pascalName: string, snakeName: string): string {
  return `/**
 * tests/${snakeName}.test.ts
 *
 * Unit tests for ${pascalName}Tool.
 */

import { describe, it, expect } from 'vitest';
import { ${pascalName}Tool, ${pascalName}ParamsSchema } from '../backend/tools/${pascalName}Tool';

describe('${pascalName}Tool', () => {
  it('validates correct parameter schemas', () => {
    const valid = { destination: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVGCMZ' };
    const parsed = ${pascalName}ParamsSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('rejects missing destination', () => {
    const invalid = { description: 'test without destination' };
    const parsed = ${pascalName}ParamsSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  it('executes task successfully', async () => {
    const tool = new ${pascalName}Tool();
    const result = await tool.execute({ destination: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVGCMZ' });

    expect(result.success).toBe(true);
    expect(result.data.destination).toBe('GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVGCMZ');
  });
});
`;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('❌ Error: Tool name is required.\nUsage: npm run new-tool <ToolName>');
    process.exit(1);
  }

  const pascalName = toPascalCase(arg);
  const snakeName = toSnakeCase(pascalName);

  const toolFilePath = resolve(process.cwd(), 'backend', 'tools', `${pascalName}Tool.ts`);
  const testFilePath = resolve(process.cwd(), 'tests', `${snakeName}.test.ts`);

  if (existsSync(toolFilePath)) {
    console.error(`❌ Error: Tool file already exists at ${toolFilePath}`);
    process.exit(1);
  }

  mkdirSync(resolve(process.cwd(), 'backend', 'tools'), { recursive: true });
  mkdirSync(resolve(process.cwd(), 'tests'), { recursive: true });

  writeFileSync(toolFilePath, generateToolCode(pascalName, snakeName), 'utf8');
  writeFileSync(testFilePath, generateTestCode(pascalName, snakeName), 'utf8');

  console.log(`\n✨ Successfully generated new tool scaffolding!`);
  console.log(`  📄 Tool file: backend/tools/${pascalName}Tool.ts`);
  console.log(`  🧪 Test file: tests/${snakeName}.test.ts\n`);
  console.log(`Next steps to register the tool in Nodal AI:`);
  console.log(`  1. Add \`${snakeName}\` to TaskType union in backend/agent.ts`);
  console.log(`  2. Instantiate and wire ${pascalName}Tool in PayFiAgent constructor`);
  console.log(`  3. Add case '${snakeName}' to the executeTask() switch statement`);
  console.log(`  4. Run \`npm test -- tests/${snakeName}.test.ts\` to verify\n`);
}

main();
