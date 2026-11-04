import { describe, expect, it } from "vitest";
import { classifyTarget, type TargetInput } from "../src/map/target-class.js";

const HOME = "/Users/tester";
const PROJECT = "demo-app.git";

/** Every row of schema 4.4, in table order, plus the privacy cases. */
const CASES: Array<{ name: string; input: TargetInput; class: string; family: string }> = [
  { name: "1 network host, no port, path or query", input: { toolId: "WebFetch", targetPath: "https://api.example.com:8443/v1/x?token=abc" }, class: "network:api.example.com", family: "network" },
  { name: "2 secret ssh key", input: { toolId: "Read", targetPath: "/Users/tester/.ssh/id_ed25519", home: HOME }, class: "secret:ssh-key", family: "secret" },
  { name: "2 secret cloud credentials", input: { toolId: "Read", targetPath: "/Users/tester/.aws/credentials", home: HOME }, class: "secret:cloud-credential", family: "secret" },
  { name: "2 secret env file in a project", input: { toolId: "Read", targetPath: "/Users/tester/dev/demo-app.git/.env.production", home: HOME, project: PROJECT }, class: "secret:env-file", family: "secret" },
  { name: "2 secret key file", input: { toolId: "Write", targetPath: "/srv/deploy/server.pem" }, class: "secret:key-file", family: "secret" },
  { name: "2 secret relative env", input: { toolId: "Read", targetPath: ".env" }, class: "secret:env-file", family: "secret" },
  { name: "3 tmp", input: { toolId: "Write", targetPath: "/tmp/a.txt" }, class: "tmp:/**", family: "tmp" },
  { name: "3 tmp under private var folders", input: { toolId: "Write", targetPath: "/private/var/folders/ab/cd/T/x" }, class: "tmp:/**", family: "tmp" },
  { name: "4 system etc", input: { toolId: "Read", targetPath: "/etc/hosts" }, class: "system:/etc/**", family: "system" },
  { name: "4 system usr", input: { toolId: "Read", targetPath: "/usr/local/bin/x" }, class: "system:/usr/**", family: "system" },
  { name: "4 system private etc", input: { toolId: "Read", targetPath: "/private/etc/x" }, class: "system:/private/etc/**", family: "system" },
  { name: "5 project subtree", input: { toolId: "Edit", targetPath: "/Users/tester/dev/demo-app.git/src/a/b.ts", project: PROJECT, home: HOME }, class: "project:demo-app.git/src/**", family: "project" },
  { name: "5 project root file", input: { toolId: "Edit", targetPath: "/Users/tester/dev/demo-app.git/README.md", project: PROJECT, home: HOME }, class: "project:demo-app.git/*", family: "project" },
  { name: "6 relative project path", input: { toolId: "Edit", targetPath: "src/a.ts" }, class: "project:(relative)/src/**", family: "project" },
  { name: "6 relative root file", input: { toolId: "Edit", targetPath: "README.md" }, class: "project:(relative)/*", family: "project" },
  { name: "7 home dot folder", input: { toolId: "Edit", targetPath: "/Users/tester/.zshrc", home: HOME }, class: "home:dot/**", family: "home" },
  { name: "7 home dot folder with tilde", input: { toolId: "Edit", targetPath: "~/.config/tool/x.toml" }, class: "home:dot/**", family: "home" },
  { name: "7 root home dot folder", input: { toolId: "Edit", targetPath: "/root/.bashrc" }, class: "home:dot/**", family: "home" },
  { name: "8 other home path, option home", input: { toolId: "Write", targetPath: "/Users/tester/Documents/x.txt", home: HOME }, class: "home:other", family: "home" },
  { name: "8 other home path, no option", input: { toolId: "Write", targetPath: "/home/bob/notes/x" }, class: "home:other", family: "home" },
  { name: "9 other absolute path", input: { toolId: "Write", targetPath: "/Volumes/Backup/x" }, class: "absolute:other", family: "other" },
  { name: "10 command binary", input: { toolId: "Bash", summary: "shell git (+2 args)" }, class: "command:git", family: "command" },
  { name: "10 command binary from full path", input: { toolId: "Bash", summary: "shell /usr/bin/curl (+1 args)" }, class: "command:curl", family: "command" },
  { name: "10 command with no args", input: { toolId: "Bash", summary: "shell ls" }, class: "command:ls", family: "command" },
  { name: "10 command, bin that is not a name", input: { toolId: "Bash", summary: "shell ./tok=abc" }, class: "command:other", family: "command" },
  { name: "10 command, bin is a URL gives host", input: { toolId: "Bash", summary: "shell https://u:p@evil.example/x?token=1" }, class: "network:evil.example", family: "network" },
  { name: "10 command, bin is a broken URL", input: { toolId: "Bash", summary: "shell https://[bad" }, class: "network:other", family: "network" },
  { name: "11 no target and no shell line", input: { toolId: "mcp__x__y" }, class: "none", family: "none" },
  { name: "11 summary that is not the shell shape", input: { toolId: "Bash", summary: "run curl with secret" }, class: "none", family: "none" },
  { name: "11 shell line with no binary", input: { toolId: "Bash", summary: "shell" }, class: "none", family: "none" },
  { name: "order: target wins over shell line", input: { toolId: "Bash", targetPath: "/Volumes/x", summary: "shell git (+1 args)" }, class: "absolute:other", family: "other" },
  { name: "order: URL wins over secret-looking host path", input: { toolId: "Read", targetPath: "https://h.example/.env" }, class: "network:h.example", family: "network" },
];

describe("classifyTarget: schema 4.4 rows", () => {
  it.each(CASES)("$name", ({ input, class: cls, family }) => {
    expect(classifyTarget(input)).toEqual({ class: cls, family });
  });
});

describe("classifyTarget: privacy", () => {
  it("a URL with user:pass@host/path?token=x gives only the host", () => {
    const r = classifyTarget({ toolId: "WebFetch", targetPath: "https://user:pass@host.example/path/secret?token=x#frag" });
    expect(r).toEqual({ class: "network:host.example", family: "network" });
    expect(JSON.stringify(r)).not.toMatch(/user|pass|path|secret|token|frag/);
  });

  it("a relative path with userinfo never puts the userinfo in the class", () => {
    const r = classifyTarget({ toolId: "Edit", targetPath: "user:pass@host/path?token=x" });
    expect(r.class).toBe("project:(relative)/(other)/**");
    expect(JSON.stringify(r)).not.toMatch(/user|pass|host|token/);
  });

  it("a command with an argument that looks like a secret gives only the binary", () => {
    const r = classifyTarget({ toolId: "Bash", summary: "shell curl (+2 args)" });
    expect(r).toEqual({ class: "command:curl", family: "command" });
    expect(JSON.stringify(r)).not.toMatch(/token|key|secret|password/);
  });

  it("a secret path never returns the raw path or its file name", () => {
    const r = classifyTarget({ toolId: "Read", targetPath: "/Users/tester/dev/demo-app.git/config/prod-api-key.pem", home: HOME, project: PROJECT });
    expect(r.class).toBe("secret:key-file");
    expect(JSON.stringify(r)).not.toMatch(/prod|api|config|tester|demo-app|\.pem/);
  });

  it("a project file name never appears in the project class", () => {
    const r = classifyTarget({ toolId: "Edit", targetPath: "/Users/tester/dev/demo-app.git/payroll-2026.xlsx", home: HOME, project: PROJECT });
    expect(r.class).toBe("project:demo-app.git/*");
    expect(JSON.stringify(r)).not.toMatch(/payroll/);
  });

  it("a directory segment that carries a colon or equals sign is replaced", () => {
    expect(classifyTarget({ toolId: "Edit", targetPath: "/x/demo-app.git/tok=abc/f", project: PROJECT }).class).toBe(
      "project:demo-app.git/(other)/**",
    );
  });

  it("is deterministic: same input gives same output", () => {
    const input: TargetInput = { toolId: "Edit", targetPath: "src/a.ts" };
    expect(classifyTarget(input)).toEqual(classifyTarget(input));
  });
});

describe("classifyTarget: review fixes (N6)", () => {
  const cls = (i: TargetInput) => classifyTarget(i).class;

  it("item 2: with a cwd, a path is in the project only when it is under that directory", () => {
    // cwd named like a system folder: another user's home path is not project:home/bob/**
    expect(cls({ toolId: "Read", targetPath: "/home/bob/x/y", project: "home", cwd: "/home" })).toBe("home:other");
    // a same-named folder elsewhere is not the project
    expect(cls({ toolId: "Read", targetPath: "/Users/a/src/private-dir/f", project: "src", cwd: "/w/src" })).toBe("home:other");
    // under the cwd: project class, exact directory name kept
    expect(cls({ toolId: "Edit", targetPath: "/w/src/private-dir/f", project: "src", cwd: "/w/src" })).toBe("project:src/private-dir/**");
    // cwd is the home folder: its name is the user name, so no project class
    expect(cls({ toolId: "Edit", targetPath: "/Users/tester/Documents/x", project: "tester", cwd: "/Users/tester", home: "/Users/tester" })).toBe("home:other");
  });

  it("item 2: without a cwd (old rows) reserved folder names never make a project and unknown directory names are hidden", () => {
    expect(cls({ toolId: "Read", targetPath: "/home/bob/x/y", project: "home" })).toBe("home:other");
    expect(cls({ toolId: "Edit", targetPath: "/Users/t/dev/app/secret-client-name/f", project: "app" })).toBe("project:app/(other)/**");
    expect(cls({ toolId: "Edit", targetPath: "/Users/t/dev/app/src/f", project: "app" })).toBe("project:app/src/**");
  });

  it("item 3: only network schemes give a host, and the host must look like a host", () => {
    expect(cls({ toolId: "WebFetch", targetPath: "x://secret%2Fpath%3Fq%3Dtoken" })).toBe("network:other");
    expect(cls({ toolId: "WebFetch", targetPath: "foo://user:pw@host/p?token=1" })).toBe("network:other");
    expect(cls({ toolId: "WebFetch", targetPath: "https://USER:pw@API.Example.com:8443/p?q=1" })).toBe("network:api.example.com");
    expect(cls({ toolId: "WebFetch", targetPath: "wss://stream.example.com/x" })).toBe("network:stream.example.com");
    expect(cls({ toolId: "Bash", summary: "shell gopher://evil%2Ftoken" })).toBe("network:other");
  });

  it("re-review: a file: URL is judged as a path, so secret and system targets keep their class", () => {
    expect(cls({ toolId: "Read", targetPath: "file:///Users/bob/.aws/credentials", home: "/Users/bob" })).toBe("secret:cloud-credential");
    expect(cls({ toolId: "Read", targetPath: "file:///home/bob/.ssh/id_ed25519" })).toBe("secret:ssh-key");
    expect(cls({ toolId: "Read", targetPath: "file:///etc/passwd" })).toBe("system:/etc/**");
    expect(cls({ toolId: "Read", targetPath: "file:///tmp/a%20b/c" })).toBe("tmp:/**");
    expect(cls({ toolId: "Read", targetPath: "file://host/share/x" })).not.toContain("share");
  });

  it("re-review: a cwd shaped like a home folder gives no project class even when HOME is elsewhere", () => {
    for (const cwd of ["/Users/bob", "/home/bob", "/root"]) {
      const c = cls({ toolId: "Read", targetPath: `${cwd}/Clients X/f`, project: cwd.split("/").pop(), cwd, home: "/somewhere/else" });
      expect(c).not.toMatch(/^project:/);
      expect(c).not.toContain("Clients");
    }
    expect(cls({ toolId: "Edit", targetPath: "/srv/work/app/src/f", project: "app", cwd: "/srv/work/app" })).toBe("project:app/src/**");
  });
});
