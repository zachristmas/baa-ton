#!/usr/bin/env node
/**
 * Post or list directives for a Baa-ton root.
 *
 *   node directive.mjs post --manifest <parent manifest> --root <orchestrator id> --from <name> --text "<directive>"
 *   node directive.mjs list --manifest <parent manifest> [--root <orchestrator id>]
 *
 * A directive is delivered in the root digest and stays open until the root
 * acknowledges it with herdr_directive; the controller re-sends it once, then
 * escalates with a Herdr notification.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { postDirective } from "./controller.mjs";

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}.`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (!options.manifest) throw new Error("--manifest is required.");
  const manifestPath = resolve(options.manifest);
  if (command === "post") {
    for (const key of ["root", "from", "text"])
      if (!options[key]) throw new Error(`--${key} is required.`);
    const directive = await postDirective({
      manifestPath,
      rootId: options.root,
      from: options.from,
      text: options.text,
    });
    process.stdout.write(`${JSON.stringify(directive, null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const directives = (Array.isArray(manifest.directives) ? manifest.directives : []).filter(
      (directive) => !options.root || directive.rootId === options.root,
    );
    for (const directive of directives)
      process.stdout.write(
        `${directive.id} [${directive.status}${directive.escalatedAt ? ", escalated" : ""}] sends=${directive.sends ?? 0} ${directive.from}: ${directive.text}\n`,
      );
    if (!directives.length) process.stdout.write("No directives.\n");
    return;
  }
  throw new Error("Usage: directive.mjs post|list --manifest <path> ...");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
