/**
 * backend/ai/toolSchemas.ts
 *
 * Generates JSON Schema from Zod input schemas for all registered tools.
 * Provides machine-readable tool definitions for LLMs and MCP clients.
 *
 * Usage:
 *   npm run tools:schema   # Generate docs/tools.schema.json
 *   import { generateToolSchemas, getToolSchemaArray } from './ai/toolSchemas';
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// Import the built-in tools to extract their schemas
import { createBuiltinTools } from '../tools/builtin';

// ─── Configuration ────────────────────────────────────────────────────────────

const SCHEMA_OUTPUT_DIR = 'docs';
const SCHEMA_OUTPUT_FILE = 'tools.schema.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolSchema {
  /** Task type this tool handles (e.g., 'stellar_payment') */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's input payload */
  input_schema: Record<string, unknown>;
  /** Whether the tool can move funds out of the agent's account */
  value_moving: boolean;
}

export interface ToolSchemaCollection {
  /** Version of the schema format */
  version: string;
  /** Generated timestamp (ISO 8601) */
  generated_at: string;
  /** Array of all tool schemas */
  tools: ToolSchema[];
  /** Statistics about the generated schemas */
  stats: {
    total_tools: number;
    value_moving_tools: number;
    tools_with_descriptions: number;
  };
}

// ─── Schema Generator ────────────────────────────────────────────────────────
/** JSON Schema drafts z.toJSONSchema can emit. */
type SchemaTarget = 'draft-07' | 'draft-2020-12';

/**
 * Options for schema generation.
 */
export interface GenerateSchemaOptions {
  /** Target JSON Schema version (default: draft-07) */
  targetSchema?: SchemaTarget;
}

/**
 * Generates JSON Schema definitions for all registered tools.
 *
 * @param options - Generation options
 * @returns Collection of tool schemas with metadata
 */
export function generateToolSchemas(options: GenerateSchemaOptions = {}): ToolSchemaCollection {
  const { targetSchema = 'draft-07' } = options;

  // Create a fresh set of tools to get their current schemas
  const tools = createBuiltinTools();

  const toolSchemas: ToolSchema[] = tools.map((tool) => {
    // Convert Zod schema to JSON Schema
    // io: 'input' because this describes what a caller sends, before transforms;
    // unrepresentable: 'any' because refinements are enforced at runtime anyway.
    const jsonSchema = z.toJSONSchema(tool.inputSchema as z.ZodType<unknown>, {
      target: targetSchema,
      io: 'input',
      unrepresentable: 'any',
    });

    return {
      name: tool.name,
      description: tool.description,
      input_schema: jsonSchema as Record<string, unknown>,
      value_moving: tool.valueMoving,
    };
  });

  // Calculate statistics
  const valueMovingCount = toolSchemas.filter((t) => t.value_moving).length;
  const describedCount = toolSchemas.filter(
    (t) => t.description && t.description.length > 0
  ).length;

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    tools: toolSchemas,
    stats: {
      total_tools: toolSchemas.length,
      value_moving_tools: valueMovingCount,
      tools_with_descriptions: describedCount,
    },
  };
}

/**
 * Returns a simple array of tool schemas (name, description, input_schema).
 * This is the format expected by LLM function-calling APIs.
 *
 * @returns Array of tool schema definitions
 */
export function getToolSchemaArray(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  const collection = generateToolSchemas();
  return collection.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Returns a specific tool's schema by name.
 *
 * @param toolName - The name of the tool to look up
 * @returns The tool's schema or undefined if not found
 */
export function getToolSchema(toolName: string): ToolSchema | undefined {
  const collection = generateToolSchemas();
  return collection.tools.find((t) => t.name === toolName);
}

// ─── File Export ────────────────────────────────────────────────────────────

/**
 * Writes the generated schemas to a JSON file.
 *
 * @param outputPath - Optional custom output path
 * @param options - Schema generation options
 * @returns The path where the schema was written
 */
export function writeSchemasToFile(
  outputPath?: string,
  options: GenerateSchemaOptions = {}
): string {
  const schemas = generateToolSchemas(options);
  const filePath = outputPath || path.join(process.cwd(), SCHEMA_OUTPUT_DIR, SCHEMA_OUTPUT_FILE);

  // Ensure the output directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write the JSON file with pretty formatting
  const jsonContent = JSON.stringify(schemas, null, 2);
  fs.writeFileSync(filePath, jsonContent, 'utf-8');

  return filePath;
}

/**
 * Validates that all registered tools have valid, non-empty schemas.
 * This is used by CI to ensure the schema generation doesn't drift.
 *
 * @returns Validation result with any errors
 */
export function validateSchemas(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const schemas = generateToolSchemas();

    for (const tool of schemas.tools) {
      // Check that name is not empty
      if (!tool.name || tool.name.trim() === '') {
        errors.push(`Tool has empty name`);
      }

      // Check that description exists and is meaningful
      if (!tool.description || tool.description.trim() === '') {
        errors.push(`Tool '${tool.name}' has empty description`);
      }

      if (tool.description && tool.description.length < 10) {
        errors.push(
          `Tool '${tool.name}' has suspiciously short description (${tool.description.length} chars)`
        );
      }

      // Check that input_schema is valid JSON
      try {
        JSON.stringify(tool.input_schema);
      } catch {
        errors.push(`Tool '${tool.name}' has invalid input_schema`);
      }
    }

    // Check stats
    if (schemas.stats.total_tools === 0) {
      errors.push('No tools registered');
    }

    if (schemas.stats.tools_with_descriptions < schemas.stats.total_tools) {
      const missing = schemas.stats.total_tools - schemas.stats.tools_with_descriptions;
      errors.push(`${missing} tool(s) missing descriptions`);
    }
  } catch (err) {
    errors.push(`Schema generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─── CLI Interface ────────────────────────────────────────────────────────────

/**
 * Main entry point for CLI usage.
 * Reads the --check flag to validate instead of generating.
 */
function main(): void {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  if (checkMode) {
    // Validate schemas (used in CI)
    const result = validateSchemas();

    if (!result.valid) {
      process.stderr.write('Schema validation failed:\n');
      result.errors.forEach((err) => process.stderr.write(`  - ${err}\n`));
      process.exit(1);
    }

    process.stdout.write('Schema validation passed\n');
    process.exit(0);
  }

  // Generate schemas
  try {
    const outputPath = writeSchemasToFile();
    process.stdout.write(`Generated tool schemas: ${outputPath}\n`);

    // Print summary
    const schemas = generateToolSchemas();
    process.stdout.write(
      `\nSummary:\n` +
        `  Total tools: ${schemas.stats.total_tools}\n` +
        `  Value-moving tools: ${schemas.stats.value_moving_tools}\n` +
        `  Tools with descriptions: ${schemas.stats.tools_with_descriptions}\n`
    );
  } catch (err) {
    process.stderr.write(
      `Failed to generate schemas: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}
