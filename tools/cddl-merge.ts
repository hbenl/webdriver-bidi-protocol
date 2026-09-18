import { parse } from "cddlparser";
import {
  Array as CddlArray,
  Group,
  GroupChoice,
  GroupEntry,
  Map as CddlMap,
  Type,
  type CDDLTree,
  type Rule,
} from "cddlparser/ast.js";

/** Suffix that marks a rule in the extension file as an extension. */
export const EXTENSION_SUFFIX = "Extension";

/**
 * The `Token` class is not part of cddlparser's public exports, so we refer to
 * the type through a node that holds one.
 */
type Separator = NonNullable<GroupEntry["separator"]>;

/** Raised when the two files cannot be merged. Collects all problems found. */
export class MergeError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Cannot merge CDDL files:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "MergeError";
    this.problems = problems;
  }
}

export interface MergeOptions {
  /** Name of the main file, used in error messages. */
  mainName?: string;
  /** Name of the extension file, used in error messages. */
  extensionName?: string;
}

/**
 * Merge a main CDDL file with an extension CDDL file.
 *
 * A rule in the extension file whose name ends with "Extension" must be a group
 * named after a rule in the main file, and its name is added as an entry to that
 * rule, so that the merged CDDL is the main file extended by the extension
 * groups. Any other rule of the extension file is left alone.
 *
 * @returns the merged CDDL: the modified main file followed by the unmodified
 *   extension file
 * @throws {MergeError} if the files cannot be merged
 */
export function merge(mainSource: string, extensionSource: string, options: MergeOptions = {}): string {
  const mainName = options.mainName ?? "main file";
  const extensionName = options.extensionName ?? "extension file";

  const mainTree = parseFile(mainSource, mainName);
  const extensionTree = parseFile(extensionSource, extensionName);

  const mainRules = new globalThis.Map<string, Rule>();
  for (const rule of mainTree.rules) {
    mainRules.set(rule.name.name, rule);
  }

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const extensionRule of extensionTree.rules) {
    const extensionRuleName = extensionRule.name.name;

    // Rules that are not extensions are carried over unchanged, they are
    // typically helpers that the extension groups refer to.
    if (!extensionRuleName.endsWith(EXTENSION_SUFFIX)) {
      continue;
    }

    if (seen.has(extensionRuleName)) {
      problems.push(`${extensionName} defines "${extensionRuleName}" more than once`);
      continue;
    }
    seen.add(extensionRuleName);

    if (!definesGroup(extensionRule)) {
      problems.push(
        `"${extensionRuleName}" in ${extensionName} must be a group, ` +
          `i.e. its definition must be wrapped in parentheses`,
      );
      continue;
    }

    if (mainRules.has(extensionRuleName)) {
      problems.push(`${mainName} already defines "${extensionRuleName}"`);
      continue;
    }

    const targetName = extensionRuleName.slice(0, -EXTENSION_SUFFIX.length);
    const targetRule = mainRules.get(targetName);
    if (targetRule === undefined) {
      problems.push(
        `"${extensionRuleName}" in ${extensionName} has no corresponding ` +
          `group or type "${targetName}" in ${mainName}`,
      );
      continue;
    }

    const target = extensionTargetOf(targetRule);
    if (typeof target === "string") {
      problems.push(`"${targetName}" in ${mainName} cannot be extended: ${target}`);
      continue;
    }

    addGroupEntry(target, extensionRuleName);
  }

  if (problems.length > 0) {
    throw new MergeError(problems);
  }

  const merged = joinFiles(mainTree.serialize(), extensionSource);

  // The merged CDDL is what we hand out, so make sure it still parses.
  parseFile(merged, "merged CDDL");

  return merged;
}

function parseFile(source: string, name: string): CDDLTree {
  try {
    return parse(source);
  } catch (cause) {
    throw new MergeError([`failed to parse ${name}: ${(cause as Error).message}`]);
  }
}

/** The right hand side of a rule, unwrapping the `GroupEntry` the parser may use. */
function definitionOf(rule: Rule): Type | GroupEntry {
  const { type } = rule;
  if (type instanceof GroupEntry && type.occurrence === null && type.key === null) {
    return type.type;
  }
  return type;
}

/** The map, group or array a rule defines, if it defines a single one. */
function containerOf(rule: Rule): Group | null {
  const definition = definitionOf(rule);
  if (!(definition instanceof Type) || definition.types.length !== 1) {
    return null;
  }
  const [type] = definition.types;
  return type instanceof Group ? type : null;
}

/** True if the rule defines a group, i.e. `name = ( ... )`. */
function definesGroup(rule: Rule): boolean {
  const container = containerOf(rule);
  return container !== null && !(container instanceof CddlMap) && !(container instanceof CddlArray);
}

/** The place an extension group is added to. */
interface ExtensionTarget {
  container: Group;
  groupChoice: GroupChoice;
}

/**
 * The place where an extension group should be added to a rule of the main file.
 *
 * @returns the target, or a string explaining why the rule cannot be extended
 */
function extensionTargetOf(rule: Rule): ExtensionTarget | string {
  const container = containerOf(rule);
  if (container === null) {
    const definition = definitionOf(rule);
    return definition instanceof Type && definition.types.length > 1
      ? "it is a type choice, which cannot hold a group"
      : "it does not define a map or a group";
  }
  if (container instanceof CddlArray) {
    return "it defines an array, where an added group would change the array's contents";
  }
  if (container.groupChoices.length > 1) {
    return (
      `it is a choice between ${container.groupChoices.length} groups, ` +
      `so an extension cannot be added unambiguously`
    );
  }
  if (container.closeToken === null) {
    return "it is not delimited by braces or parentheses";
  }

  // An empty map or group has no group choice yet, so start one.
  if (container.groupChoices.length === 0) {
    const groupChoice = new GroupChoice([]);
    groupChoice.parentNode = container;
    container.groupChoices.push(groupChoice);
  }

  const groupChoice = container.groupChoices[0]!;
  if (!(container instanceof CddlMap) && isParenthesizedTypeChoice(groupChoice)) {
    return "it is a type choice, which cannot hold a group";
  }

  return { container, groupChoice };
}

/**
 * True for a definition such as `Foo = (Bar / Baz)`, which the parser reports as
 * a group holding a single entry, but which really is a type choice in
 * parentheses.
 */
function isParenthesizedTypeChoice(groupChoice: GroupChoice): boolean {
  if (groupChoice.groupEntries.length !== 1) {
    return false;
  }
  const [entry] = groupChoice.groupEntries;
  return entry!.key === null && entry!.occurrence === null && entry!.type.types.length > 1;
}

/** Add `name` as the last entry of the target's group choice. */
function addGroupEntry(target: ExtensionTarget, name: string): void {
  const { container, groupChoice } = target;
  const closeToken = container.closeToken!;
  const lastEntry = groupChoice.groupEntries.at(-1);
  const { entry, separator } = buildGroupEntry(name);

  // Group entries are separated by an optional comma; keep the existing style
  // by only adding one where the previous entry does not end with one.
  if (lastEntry !== undefined && lastEntry.separator === null) {
    lastEntry.separator = separator;
  }

  // Whatever sits between the last entry and the closing token - a trailing
  // comment and the line break in front of the closing token - belongs in front
  // of the new entry now, so that the closing token keeps its own place.
  entry.comments = closeToken.comments;
  entry.whitespace = closeToken.whitespace + indentationOf(lastEntry);
  closeToken.comments = [];

  groupChoice.groupEntries.push(entry);
  entry.parentNode = groupChoice;
}

/** The indentation of the entries of a group, taken from its last entry. */
function indentationOf(lastEntry: GroupEntry | undefined): string {
  const leading = lastEntry === undefined ? "" : /^\s*/.exec(lastEntry.serialize())![0];
  const lineStart = leading.lastIndexOf("\n");
  // A group that is written on a single line is continued on that line.
  return lineStart === -1 ? " " : leading.slice(lineStart + 1);
}

/**
 * Build the group entry for an extension group, along with a separator token.
 *
 * The nodes are built by parsing a throwaway rule, because cddlparser does not
 * export the `Token` class needed to build a separator from scratch.
 */
function buildGroupEntry(name: string): { entry: GroupEntry; separator: Separator } {
  // No whitespace around the comma: the caller decides how the entry is laid
  // out, and stray whitespace would end up in the middle of the entry.
  const template = parse(`_ = (_,${name})`);
  const groupChoice = containerOf(template.rules[0]!)!.groupChoices[0]!;
  const [placeholder, entry] = groupChoice.groupEntries;
  return { entry: entry!, separator: placeholder!.separator! };
}

/** Append the extension file to the main file, separated by a blank line. */
function joinFiles(main: string, extension: string): string {
  return `${main.replace(/\s*$/, "")}\n\n${extension.replace(/^\s*/, "")}`;
}
