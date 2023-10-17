import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";

import { Config, asArray } from "../types/Config";
import { encode } from "html-entities";

function injectTagScriptsAndStyles(
    snippetDataElem: cheerio.Cheerio<cheerio.Element>,
    tagList: string,
    config: Config,
    projectRootPath: string,
    scripts: boolean
) {
    const tagRules = scripts ? config.scripts?.tags : config.styles?.tags;
    if (!tagRules) return;
    for (const tagRule of tagRules.reverse()) {
        if (evaluateTagRule(tagRule.rule, tagList)) {
            const files = asArray(tagRule.files);
            for (const file of files.reverse()) {
                const filePath = path.join(projectRootPath, file);
                if (!fs.existsSync(filePath))
                    console.warn(
                        `File "${filePath}" for tag rule "${tagRule}" not found, skipping...`
                    );
                if (scripts)
                    snippetDataElem.prepend(
                        `<% ${encode(fs.readFileSync(filePath, "utf8"))} %>`
                    );
                else
                    snippetDataElem.prepend(
                        `<style>
                        ${fs.readFileSync(filePath, "utf8")}
                        </style>`
                    );
            }
        }
    }
}

export function injectTagsScriptsAndStyles(
    snippetDataElem: cheerio.Cheerio<cheerio.Element>,
    config: Config,
    projectRootPath: string
) {
    const tagList = (snippetDataElem.data("tags") as string) || "";
    injectTagScriptsAndStyles(
        snippetDataElem,
        tagList,
        config,
        projectRootPath,
        true
    );
    injectTagScriptsAndStyles(
        snippetDataElem,
        tagList,
        config,
        projectRootPath,
        false
    );
}

class TokenizationError extends Error {}
class EvaluationError extends Error {}
class TagError extends Error {}

class ExpTreeNode {
    value: string;
    left: ExpTreeNode | null;
    right: ExpTreeNode | null;

    constructor(value: string) {
        this.value = value;
        this.left = null;
        this.right = null;
    }
}

/**
 * @throws {TokenizationError}
 */
function tokenizeAndCheckRule(rule: string): string[] {
    const tokens = rule.match(/([A-Za-z][A-Za-z0-9_]*|\|\||&&|!|\(|\))/g);

    if (tokens === null)
        throw new TokenizationError(
            "Malformed expression (tokenization failed)"
        );

    // check that all characters are valid
    if (tokens.join("") !== rule.replace(/\s/g, ""))
        throw new TokenizationError(
            "Invalid characters found in the expression"
        );

    // check that the parentheses are balanced
    let parcnt = 0;
    for (const token of tokens) {
        if (token === "(") parcnt++;
        else if (token === ")") parcnt--;
        if (parcnt < 0)
            throw new TokenizationError(
                "Unbalanced parentheses (more closing than opening)"
            );
    }
    if (parcnt > 0)
        throw new TokenizationError(
            "Unbalanced parentheses (more opening than closing)"
        );

    // check that there are no consecutive tags
    for (let i = 0; i < tokens.length - 1; i++) {
        if (
            /^[A-Za-z][A-Za-z0-9_]*$/.test(tokens[i]) &&
            /^[A-Za-z][A-Za-z0-9_]*$/.test(tokens[i + 1])
        )
            throw new TokenizationError(
                "Consecutive tags found in the expression"
            );
    }

    // check that there are no consecutive operators
    for (let i = 0; i < tokens.length - 1; i++) {
        if (["&&", "||"].includes(tokens[i])) {
            if (["&&", "||"].includes(tokens[i + 1]))
                throw new TokenizationError(
                    "Consecutive operators found in the expression"
                );
        }
    }

    // check that there are no operators next to parentheses
    for (let i = 1; i < tokens.length - 1; i++) {
        if (["&&", "||"].includes(tokens[i])) {
            if (tokens[i - 1] === "(" || tokens[i + 1] === ")")
                throw new TokenizationError(
                    "Operator found next to parentheses in the expression"
                );
        }
    }

    // check that there are no operators at the beginning or end
    if (["&&", "||"].includes(tokens[0]))
        throw new TokenizationError(
            "Operator found at the beginning of the expression"
        );
    if (["&&", "||"].includes(tokens[tokens.length - 1]))
        throw new TokenizationError(
            "Operator found at the end of the expression"
        );

    return tokens;
}

/**
 * @throws {EvaluationError}
 */
function buildExpressionTree(tokens: string[]): ExpTreeNode | null {
    if (tokens.length === 0) return null;
    if (tokens.length === 1) {
        return new ExpTreeNode(tokens[0]);
    }
    // find index of operators on current level
    let opIndicies = [];
    let parcnt = tokens[0] === "(" ? 1 : 0;
    let i = 0;
    while (i < tokens.length - 1) {
        i++;
        if (tokens[i] === "(") parcnt++;
        else if (tokens[i] === ")") parcnt--;
        else if (parcnt === 0 && ["&&", "||"].includes(tokens[i]))
            opIndicies.push(i);
    }
    // if there is any || operator, use this as the root
    if (opIndicies.length > 0) {
        for (const i of opIndicies) {
            if (tokens[i] === "||") {
                const root = new ExpTreeNode(tokens[i]);
                root.left = buildExpressionTree(tokens.slice(0, i));
                root.right = buildExpressionTree(tokens.slice(i + 1));
                return root;
            }
        }
        // no || operator found, use && as the root
        const opidx = opIndicies[0];
        const root = new ExpTreeNode(tokens[opidx]);
        root.left = buildExpressionTree(tokens.slice(0, opidx));
        root.right = buildExpressionTree(tokens.slice(opidx + 1));
        return root;
    }
    // no operators found, can only be parentheses or negation
    if (tokens[0] === "(") {
        // case 1: parentheses ['(', ... , ')']
        return buildExpressionTree(tokens.slice(1, tokens.length - 1));
    }
    if (tokens[0] === "!") {
        // case 2: negation ['!', ...]
        const root = new ExpTreeNode(tokens[0]);
        root.right = buildExpressionTree(tokens.slice(1));
        return root;
    }

    throw new EvaluationError("Invalid expression (or tree building failed)");
}

function evaluateExpressionTree(
    tree: ExpTreeNode | null,
    tags: string[]
): boolean {
    if (tree === null) return false;
    if (tree.value === "!") return !evaluateExpressionTree(tree.right, tags);
    if (tree.value === "&&")
        return (
            evaluateExpressionTree(tree.left, tags) &&
            evaluateExpressionTree(tree.right, tags)
        );
    if (tree.value === "||")
        return (
            evaluateExpressionTree(tree.left, tags) ||
            evaluateExpressionTree(tree.right, tags)
        );
    return tags.includes(tree.value);
}

/**
 * Evaluates a tag rule.
 *
 * @param rule The rule to evaluate.
 * @param tagList The list of tags to evaluate the rule against.
 * @returns The result of the evaluation (true or false).
 * @throws {TokenizationError} If the rule is malformed.
 * @throws {EvaluationError} If the rule is invalid.
 * @throws {TagError} If the tag list is malformed.
 *
 * @example
 * evaluateTagRule("a && b", "a b"); // true
 * evaluateTagRule("a && b", "a"); // false
 * evaluateTagRule("a && b b", "a b"); // throws TokenizationError
 */
export function evaluateTagRule(rule: string, tagList: string): boolean {
    const tags = tagList
        .trim()
        .split(/ +/)
        .filter((t) => t.length > 0);

    for (const tag of tags)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag))
            throw new TagError(`Invalid tag "${tag}"!`);

    let tokens = tokenizeAndCheckRule(rule);
    const tree = buildExpressionTree(tokens);
    return evaluateExpressionTree(tree, tags);
}
