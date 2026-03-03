import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, basename, join } from "path";

export interface ParseResult {
  cwd: string | null;
  cwdToken: string | null;
  prompt: string;
  candidates: string[];
}

/**
 * Parse raw message text into cwd + prompt.
 * Rules:
 * 1. Take first whitespace-delimited token, expand ~
 * 2. fs.existsSync + isDirectory → resolved cwd, rest is prompt
 * 3. Else → fuzzyMatch(token, knownProjects)
 * 4. Matches → cwd=null, candidates=matches, prompt=full text
 * 5. No matches → cwd=null, candidates=[], prompt=full text
 */
export function parseMessage(text: string, knownProjects: string[]): ParseResult {
  const parts = text.trim().split(/\s+/);
  const token = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");

  if (!token) {
    return { cwd: null, cwdToken: null, prompt: text, candidates: [] };
  }

  const expanded = expandHome(token);

  try {
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return {
        cwd: resolve(expanded),
        cwdToken: token,
        prompt: rest,
        candidates: [],
      };
    }
  } catch {
    // ignore stat errors
  }

  const candidates = fuzzyMatch(token, knownProjects);
  return {
    cwd: null,
    cwdToken: token,
    prompt: text,
    candidates,
  };
}

/**
 * Fuzzy match token against project basenames and last two path segments.
 * Case-insensitive, returns up to 5 results.
 */
export function fuzzyMatch(token: string, projects: string[]): string[] {
  const lower = token.toLowerCase();
  const results: string[] = [];

  for (const p of projects) {
    const base = basename(p).toLowerCase();
    const parts = p.split("/").filter(Boolean);
    const lastTwo = parts.slice(-2).join("/").toLowerCase();

    if (base.includes(lower) || lastTwo.includes(lower)) {
      results.push(p);
      if (results.length >= 5) break;
    }
  }

  return results;
}

/**
 * Scan workspace dirs one level deep for project directories.
 */
export function scanProjects(workspaceDirs: string[]): string[] {
  const projects: string[] = [];

  for (const dir of workspaceDirs) {
    const expanded = expandHome(dir);
    try {
      if (!existsSync(expanded) || !statSync(expanded).isDirectory()) continue;
      const entries = readdirSync(expanded);
      for (const entry of entries) {
        const full = join(expanded, entry);
        try {
          if (statSync(full).isDirectory()) projects.push(full);
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return projects;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}
