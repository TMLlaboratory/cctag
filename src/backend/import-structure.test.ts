import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const RAW_MODULE = normalize(join(SRC, "backend", "raw"));
const PROMPT_MODULE = normalize(join(SRC, "backend", "prompt"));
const PROMPT_FACTORY_IMPORTERS = new Set([
  normalize(join(SRC, "agents", "claude", "driver.ts")),
  normalize(join(SRC, "agents", "codex", "driver.ts")),
]);
const CODEX_MODEL_PROMPT_FACTORY_IMPORTER = normalize(join(SRC, "agents", "codex", "driver.ts"));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function resolvedModule(importer: string, moduleName: string): string {
  return normalize(resolve(dirname(importer), moduleName)).replace(/\.(?:[cm]?js|tsx?)$/, "");
}

function hasRuntimeImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly !== true;
  }
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((specifier) => !specifier.isTypeOnly);
}

function importsModelMenuFactory(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
    return node.exportClause.elements.some(
      (specifier) => (specifier.propertyName ?? specifier.name).text === "createVerifiedModelMenuPrompt",
    );
  }
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return false;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some(
    (specifier) => (specifier.propertyName ?? specifier.name).text === "createVerifiedModelMenuPrompt",
  );
}

function importViolations(importer: string, content: string): string[] {
  const source = ts.createSourceFile(importer, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const checkModule = (moduleName: string, runtime: boolean, modelFactory = false): void => {
    const target = resolvedModule(importer, moduleName);
    const relativeImporter = relative(SRC, importer).split("\\").join("/");
    if (target === RAW_MODULE && !relativeImporter.startsWith("backend/")) {
      violations.push(`${relativeImporter} imports backend/raw`);
    }
    if (target === PROMPT_MODULE && runtime && !PROMPT_FACTORY_IMPORTERS.has(normalize(importer))) {
      violations.push(`${relativeImporter} imports prompt factories at runtime`);
    }
    if (
      target === PROMPT_MODULE &&
      modelFactory &&
      normalize(importer) !== CODEX_MODEL_PROMPT_FACTORY_IMPORTER
    ) {
      violations.push(`${relativeImporter} imports the Codex model-menu factory outside codex/driver.ts`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkModule(node.moduleSpecifier.text, hasRuntimeImport(node), importsModelMenuFactory(node));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      checkModule(node.arguments[0].text, true, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

test("backend raw writes and prompt factories stay behind their intended boundaries", () => {
  const violations = sourceFiles(SRC).flatMap((path) => importViolations(path, readFileSync(path, "utf8")));
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the boundary scan catches synthetic violations but permits type-only prompt imports", () => {
  const consumer = join(SRC, "commands.ts");
  assert.deepEqual(
    importViolations(consumer, 'import { createVerifiedPrompt } from "./backend/prompt.js";'),
    ["commands.ts imports prompt factories at runtime"],
  );
  assert.deepEqual(
    importViolations(consumer, 'import { createVerifiedModelMenuPrompt } from "./backend/prompt.js";'),
    [
      "commands.ts imports prompt factories at runtime",
      "commands.ts imports the Codex model-menu factory outside codex/driver.ts",
    ],
  );
  assert.deepEqual(
    importViolations(
      CODEX_MODEL_PROMPT_FACTORY_IMPORTER,
      'import { createVerifiedModelMenuPrompt } from "../../backend/prompt.js";',
    ),
    [],
  );
  assert.deepEqual(
    importViolations(
      join(SRC, "agents", "claude", "driver.ts"),
      'import { createVerifiedModelMenuPrompt } from "../../backend/prompt.js";',
    ),
    ["agents/claude/driver.ts imports the Codex model-menu factory outside codex/driver.ts"],
  );
  assert.deepEqual(
    importViolations(consumer, 'import type { VerifiedPrompt } from "./backend/prompt.js";'),
    [],
  );
  assert.deepEqual(
    importViolations(consumer, 'import { sendText } from "./backend/raw.js";'),
    ["commands.ts imports backend/raw"],
  );
});
