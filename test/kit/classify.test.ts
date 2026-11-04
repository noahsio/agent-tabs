import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { classify, commandsOf, isUnknownWriteTool } from "../../kit/guard/classify.mjs";
// @ts-expect-error plain ESM without types
import { loadDefaultRules, validateRules } from "../../kit/guard/rules.mjs";
import { readFileSync } from "node:fs";

const defaults = loadDefaultRules();
 const whitelisted = { ...defaults, ipWhitelist: ["203.0.113.20", "203.0.113.0/24", "2001:db8:1::/48"].map((cidr) => ({ cidr })) };
const CWD = "/work/proj";

const bash = (command: string, rules = defaults) => classify({ tool_name: "bash", tool_input: { command }, cwd: CWD, home: "/Users/u" }, rules);
const evalCode = (code: string, rules = defaults) => classify({ tool_name: "eval", tool_input: { language: "js", code }, cwd: CWD }, rules);

describe("escalation_forms", () => {
  const escalate = [
    "git push origin main",
    "git -C repo push",
    "git --git-dir=/x/.git push",
    "git --git-dir /x/.git --work-tree /x push",
    "git -c core.editor=true push",
    "cd x && git push",
    "true || git push",
    "echo hi; git push",
    "git status | git push",
    'bash -lc "git push"',
    "sh -c 'cd x && git push origin'",
    'bash -lc "git -C x push"',
    'echo $(git push)',
    "echo `git push`",
    "(cd x; git push)",
    "FOO=1 git push",
    "sudo git push",
    "/usr/bin/git push",
    "git reset --hard",
    "git rebase -i HEAD~3",
    "git clean -fd",
    "git stash drop",
    "git stash",
    "git checkout .",
    "git checkout -- file",
    "git restore .",
    "git branch -D old",
    "chmod 777 x",
    "chmod -R 777 x",
    "cat ~/.ssh/id_ed25519",
    "ls ~/.ssh",
    "cat key.pem",
    "npm i -g x",
    "npm install --global x",
    "pnpm add -g x",
    "yarn global add x",
    "pip install x",
    "curl 8.8.8.8",
    "curl http://8.8.8.8:8080/x",
    "curl 203.0.113.21",
    "curl http://203.0.113.10:8080/health",
    "ssh user@[2001:db8::1]",
    "ping6 2606:4700:4700::1111",
    "nc ::ffff:8.8.8.8 53",
  ];
  it.each(escalate)("escalates: %s", (command) => {
    const verdict = bash(command);
    expect(verdict.tier).toBe("escalate");
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  const allow = [
    "git status",
    "git push --help",
    "git -C repo push --help",
    "git stash list",
    "git stash show -p",
    "git diff && git log --oneline",
    "git checkout main",
    "git branch -d merged",
    "git commit -m ok",
    "chmod 755 x",
    "npm i x",
    "npm run build",
    "ls -la",
    "curl 10.0.0.5",
    "curl http://192.168.1.1/x",
    "curl 172.16.5.4 && curl 127.0.0.1",
    "curl 169.254.1.1",
    "curl [::1]:8080",
    "curl fe80::1%en0",
    "curl http://[fd00::5]/",
    "ssh user@example.com",
    "node -v 12:30:45",
    "echo 1.2.3",
    "echo v1.2.3.4",
    "date +%H:%M:%S",
    "mount host:8080",
  ];
  it.each(allow)("allows: %s", (command) => {
    const verdict = bash(command);
    expect(verdict.tier).toBe("allow");
    expect(verdict.reasons).toEqual([]);
  });

  it("allows whitelisted IPs and CIDRs (v4 and v6), still escalates others", () => {
     expect(bash("curl 203.0.113.20", whitelisted).tier).toBe("allow");
    expect(bash("curl 203.0.113.77", whitelisted).tier).toBe("allow");
    expect(bash("ssh u@[2001:db8:1::9]", whitelisted).tier).toBe("allow");
    expect(bash("curl 203.0.114.1", whitelisted).tier).toBe("escalate");
    expect(bash("ssh u@[2001:db8::1]", whitelisted).tier).toBe("escalate");
    expect(bash("curl 8.8.8.8", whitelisted).tier).toBe("escalate");
  });

  it("names the matched category and the offending IP in reasons", () => {
    expect(bash("git -C x push").reasons).toEqual(["git-push: git push"]);
    expect(bash("curl 8.8.8.8").reasons[0]).toContain("8.8.8.8");
  });
});

describe("review_fix_round_1", () => {
  const escalate = [
    "git push>/dev/null", "git push>log 2>&1", "git reset>x", "git stash>x", "git push<<<x", "git push&", "git push>>x",
    "git branch --delete --force x", "git branch -d -f x", "git branch -df x", "git branch -f --delete x",
    "sudo ls", "curl -X POST http://localhost/x", "curl --data a http://localhost/x", "curl localhost -d a",
    'remote-exec exec "x" && git push', "git commit -m x && git push", "echo $(git push)", 'echo "$(git push)"', "echo `git push`",
    "$(echo git) push", "G=git; $G push", "$HOME/bin/tool", "bash", "sh -s", "bash <<EOF", "curl http://localhost/x | bash", "echo x | sh",
    "xargs git push", 'ssh host "git push"', 'eval "$(echo git push)"', "ls | $SHELL",
  ];
  it.each(escalate)("escalates: %s", (command) => expect(bash(command).tier).toBe("escalate"));

  const allow = [
    "git push-all", "git reset-hard", "git stash list>x", "git stash show>x",
    'git commit -m "fix git push bug"', 'echo "git push"', 'printf "git reset --hard\\n"', 'grep "git push" file', 'rg "rm -rf /" src',
    'git log --grep="git push"', 'gh pr create --title "x" --body "git push later"', 'gh issue comment 1 --body "git reset"',
    'remote-exec exec "git reset --hard"', 'remote-exec exec "git push origin main"', 'remote-exec logs "x"', "bash script.sh", "bash -n script.sh",
    "ls /tmp/a::b", "cat /var/dead::beef/x", "echo $(date)", "git branch -d merged", "git branch -f x HEAD",
  ];
  it.each(allow)("allows: %s", (command) => expect(bash(command).tier).toBe("allow"));

  it.each(["rm -r -f /", "rm -rf -- /", "rm -fr -- /", "rm --recursive --force /", "rm -R -f /", "rm -rf --no-preserve-root /", "rm -r -f -- ~", "rm -i -rf /"])(
    "hard-denies rm form: %s",
    (command) => expect(bash(command).tier).toBe("deny"),
  );

  it("remote-exec deny_if turns a remote destructive command into a hard deny", () => {
    expect(bash('remote-exec exec "rm -rf /"').tier).toBe("deny");
    expect(bash('remote-exec exec "rm -r -f -- /"').tier).toBe("deny");
    expect(bash('remote-exec exec "mkfs.ext4 /dev/x"').tier).toBe("deny");
  });

  it("quoted secrets paths and IPs outside prose are still checked", () => {
    expect(bash('cat "$HOME/.ssh/id_rsa"').tier).toBe("escalate");
    expect(bash("echo 8.8.8.8").tier).toBe("escalate");
  });

  it("rejects malformed allow entries", () => {
    expect(validateRules({ ...defaults, allow: [{ id: "x", label: "x", pattern: "(", denyIf: [] }] })[0]!.message).toMatch(/regex/);
    expect(validateRules({ ...defaults, allow: [{ id: "x", label: "x", pattern: "a" }] })[0]!.message).toMatch(/denyIf/);
    expect(validateRules({ ...defaults, allow: undefined })[0]!.field).toBe("allow");
  });
});

describe("review_fix_round_2", () => {
  const escalate = [
    "remote-exec push ~/.ssh/id_rsa", 'remote-exec exec "x" > ~/.ssh/authorized_keys', 'remote-exec exec "cat /root/.aws/credentials"',
    'echo "a b" > "/Users/x/.ssh/my key/id_rsa"', 'echo "a b" >> "/Users/x/.ssh/my key/id_rsa"', 'echo x 2> "/Users/x/.ssh/my key/e"', 'echo x >"/Users/x/.ssh/my key/e"',
    'cat < "/Users/x/.ssh/my key/id_rsa"',
    "git grep -O foo", "git grep --open-files-in-pager=vim foo", "git grep -Ovim foo", "git -C x grep -O foo",
    "git log --output=/tmp/x", "git diff --output /tmp/x", "git show --output=/Users/x/.zshrc HEAD",
    "git -c alias.x='!sh -c id' x", "git -c alias.x=!id x", "git -c core.pager=evil log", "git -c core.sshCommand=evil fetch", "git -ccore.pager=evil log",
    "git --config-env=core.pager=EVIL log", "git -c user.name=x -c core.fsmonitor=evil status",
  ];
  it.each(escalate)("escalates: %s", (command) => expect(bash(command).tier).toBe("escalate"));

  const allow = [
    'remote-exec exec "git reset --hard"', 'echo "a b" > out.txt', 'echo "a b" > "out dir/f.txt"', "git grep foo", "git log --oneline", "git log --output-indicator-new=x",
    "git -c user.name=x commit -m y", "git -c alias.x=log x", "git diff -O orderfile", 'git commit -m "x --output y"',
  ];
  it.each(allow)("allows: %s", (command) => expect(bash(command).tier).toBe("allow"));

  it("reports the git option reason", () => {
    expect(bash("git -c core.pager=evil log").reasons[0]).toContain("опасная опция");
  });
});

describe("hard_deny_globs", () => {
  const denied = ["rm -rf /", "rm -fr /", "sudo rm -rf x", "mkfs.ext4 /dev/x", "dd if=/dev/zero of=/dev/disk2", "diskutil eraseDisk JHFS+ x disk2", "rm -rf ~", "rm -rf /*", "cd x && rm -rf /", 'bash -c "sudo rm -rf x"', "rm -rf /usr/local"];
  it.each(denied)("denies: %s", (command) => {
    const verdict = bash(command);
    expect(verdict.tier).toBe("deny");
    expect(verdict.reasons[0]).toMatch(/^hard-deny:/);
  });

  it("does not deny ordinary deletions", () => {
    for (const command of ["rm -rf node_modules", "rm -rf ./dist", "rm -rf /tmp/build-x", "rm file"]) expect(bash(command).tier).toBe("allow");
  });

  it("deny wins over escalation", () => {
    expect(bash("git push; sudo rm -rf x").tier).toBe("deny");
  });
});

describe("eval_code_scanned", () => {
  it("escalates tool.bash with git push and ignores benign calls", () => {
    const verdict = evalCode('const push = await tool.bash({ command: "git push origin main" });\nconst echo = await tool.bash({ command: "echo hello" });\nreturn { push, echo };');
    expect(verdict.tier).toBe("escalate");
    expect(verdict.reasons).toEqual(["git-push: git push"]);
    expect(evalCode('return await tool.bash({ command: "echo hello", cwd: "/tmp" });').tier).toBe("allow");
  });

  it("reads Bun.spawn arrays, Bun.$ templates, child_process calls", () => {
    expect(evalCode('Bun.spawn(["git","push"])').tier).toBe("escalate");
    expect(evalCode('Bun.spawnSync({ cmd: ["git", "-C", "x", "push"] })').tier).toBe("escalate");
    expect(evalCode("await Bun.$`git push origin main`").tier).toBe("escalate");
    expect(evalCode('const cp = require("node:child_process"); cp.execSync("git reset --hard")').tier).toBe("escalate");
    expect(evalCode('import { spawnSync } from "child_process"; spawnSync("git", ["push", "-f"])').tier).toBe("escalate");
    expect(evalCode('Bun.spawn(["bash","-lc","git push"])').tier).toBe("escalate");
    expect(evalCode('Bun.spawn(["curl","8.8.8.8"])').tier).toBe("escalate");
    expect(evalCode('Bun.spawn(["rm","-rf","/"])').tier).toBe("deny");
    expect(evalCode("await tool.bash({ command: 'git ' + 'push' })").tier).toBe("escalate");
  });

  it("allows eval that runs nothing risky", () => {
    expect(evalCode('const x = await tool.bash({ command: "git status" }); return /a/.exec(x);').tier).toBe("allow");
    expect(evalCode("return [1,2,3].map((n) => n * 2);").tier).toBe("allow");
    expect(evalCode('Bun.spawn(["git","push","--help"])').tier).toBe("allow");
  });

  it("escalates conservatively when eval code cannot be parsed confidently", () => {
    expect(evalCode('const c = ["git", "push"].join(" "); await tool.bash({ command: c });').tier).toBe("escalate");
    expect(evalCode('const args = ["push"]; Bun.spawn(["git", ...args]);').tier).toBe("escalate");
    expect(evalCode('const cmd = "rm -rf " + dir; execSync(cmd)').tier).toBe("escalate");
    expect(evalCode('const host = "8.8.8.8"; const c = `curl ${host}`; execSync(c)').tier).toBe("escalate");
    expect(evalCode("const r = process.cwd(); child_process.exec(r)").tier).toBe("escalate");
  });

  it("an_interpolated_argument_is_an_unknown_value_not_an_unknown_command", () => {
    // The user's case (approval card «unparsed-eval»): `root` is bound by the eval runtime, not in the code.
    const userCase =
      "print(await read(root+'/.agent/tasks/t/raw/run-kit-check.txt')); print((await tool.grep({path:root+'/tmp/agg-commit/patches',pattern:'^old mode|^new mode',limit:10})).text); " +
      "print({overrideServices:Object.keys(Bun.YAML.parse(await fs.readFile(root+'/tmp/agg-run-kit/compose.agg.yml','utf8')).services)}); " +
      "print((await tool.bash({command:`cd '${root}' && sh -n tmp/agg-run-kit/run.sh && printf 'UPDATED-RUNNER-SYNTAX=PASS\\n'`,description:'Синтаксис исправленного stand runner',run_in_background:true})).text);";
    expect(evalCode(userCase)).toMatchObject({ tier: "allow", reasons: [] });
    for (const code of [
      "await Bun.$`ls -la ${dir}`",
      'execSync(`git -C ${root} status && cat "${root}/package.json"`)',
      "await tool.bash({ command: `cd ${root} && npm test && grep -rn ${pattern} src` })",
      "await tool.bash({ command: 'cat ' + file + ' | head -5' })",
      "await tool.bash({ command: `curl -s http://localhost:${port}/health` })",
      "await tool.bash({ command: `sh -c 'echo ${value}'` })",
      'Bun.spawn(["git", "-C", repo, "status", "--short"], { stdout: "pipe" })',
      "spawnSync('node', [script, '--check'])",
    ]) expect(evalCode(code), code).toMatchObject({ tier: "allow" });
    // the same unknown value in an argv array: never a command, a git subcommand or a delete target
    for (const code of ['Bun.spawn([cmd, "x"])', 'Bun.spawn(["rm", "-rf", dir])', 'spawnSync("git", [sub, "origin", "main"])', 'Bun.spawn(["bash", "-c", script])']) {
      expect(evalCode(code).tier, code).toBe("escalate");
    }
  });

  it("an_interpolated_command_still_escalates", () => {
    for (const code of [
      "execSync(`${cmd} --version`)",
      "execSync(`${root}/run.sh`)",
      "execSync(`/usr/local/bin/${tool} x`)",
      "execSync(`echo $(${x})`)",
      "execSync(`eval ${x}`)",
      "execSync(`sh -c ${x}`)",
      'execSync(`bash -c "${x}"`)',
      "execSync(`env ${x}`)",
      "execSync(`xargs ${x} < list.txt`)",
      "execSync(`git ${sub} origin main`)",
      "execSync(`git -c ${config} log`)",
      "execSync(`find . -name x -exec ${x} {} +`)",
      "execSync(`node -e ${code}`)",
      'execSync(`python3 -c "print(${x})"`)',
      "execSync(`GIT_SSH_COMMAND=${x} git fetch`)",
      "execSync(`ssh host ${x}`)",
      "execSync(cmd + ' --version')",
    ]) expect(evalCode(code), code).toMatchObject({ tier: "escalate" });
  });

  it("an_unknown_target_of_a_destructive_or_network_command_escalates", () => {
    for (const code of [
      "execSync(`rm -rf ${dir}`)",
      "execSync(`rm -r ${dir}`)",
      "execSync(`rm ${file}`)",
      "execSync(`cd ${dir} && rm -rf build`)",
      "execSync(`find ${dir} -name '*.log' -delete`)",
      "execSync(`mv build ${dest}`)",
      "execSync(`cp config.json ${dest}`)",
      "execSync(`chmod -R 755 ${dir}`)",
      "execSync(`chown -R me ${dir}`)",
      "execSync(`echo x > ${file}`)",
      "execSync(`echo x | tee ${file}`)",
      "execSync(`git push ${remote} main`)",
      "execSync(`curl ${url}`)",
      "execSync(`curl -s http://${host}/x`)",
      "execSync(`wget -q ${url}`)",
      "execSync(`ssh ${host} ls`)",
      "execSync(`scp out.txt ${target}`)",
      "execSync('rm -rf ' + dir)",
    ]) expect(evalCode(code), code).toMatchObject({ tier: "escalate" });
    const offline = { ...defaults, groups: { ...defaults.groups, "external-ip": false } };
    expect(evalCode("execSync(`curl ${url}`)", offline).tier).toBe("allow");
  });

  it("an_interpolated_name_bound_once_to_a_literal_is_that_literal", () => {
    expect(evalCode("const dir = '/'; execSync(`rm -rf ${dir}`)").tier).toBe("deny");
    expect(evalCode('const host = "8.8.8.8"; await tool.bash({ command: `curl ${host}` })').reasons.join(" ")).toContain("8.8.8.8");
    expect(evalCode("const root = '/work/proj'; execSync(`cd ${root} && rm -rf build`)").tier).toBe("allow");
    // reassigned, mutated, shadowed, block-scoped or (a let/var) otherwise used: an unknown value, never the literal
    for (const code of [
      "let dir = '/tmp/x'; dir = '/'; execSync(`rm -rf ${dir}`)",
      "let dir = '/tmp/x'; dir += '/..'; execSync(`rm -rf ${dir}`)",
      "const dir = '/tmp/x'; ['/'].forEach((dir) => execSync(`rm -rf ${dir}`))",
      "if (ok) { const dir = '/tmp/x'; } execSync(`rm -rf ${dir}`)",
      "let dir = '/tmp/x'; const dir2 = dir; execSync(`rm -rf ${dir}`)",
    ]) expect(evalCode(code), code).toMatchObject({ tier: "escalate" });
  });

  it("a_const_bound_once_to_a_static_string_is_that_string_wherever_it_is_passed", () => {
    // The OmO corpus: a script in a const (a template, String.raw or a replaceAll of another const) run through `bash -lc`.
    for (const code of [
      "const script = `set -e\nbun test\n`; const proc = Bun.spawn(['bash', '-lc', script], { stdout: 'pipe' }); await proc.exited;",
      "const command = \"git status --short\"; Bun.spawn(['bash','-lc',command],{stdout:'pipe',stderr:'pipe'})",
      'const base = String.raw`grep -rn "a\\bb" src | head`; Bun.spawn(["bash", "-lc", base], { env: process.env })',
      'const base = "bun test OLD"; const next = base.replaceAll("OLD", "src/x.test.ts"); Bun.spawn(["bash", "-lc", next])',
      "const cmd = 'git log --oneline -5'; execSync(cmd)",
      'const raw = String.raw`for f in src/*.ts; do echo "\\${f%.ts}"; done`; const script = raw.replaceAll("\\\\$", "$"); Bun.spawn(["bash", "-lc", script])',
    ]) expect(evalCode(code), code).toMatchObject({ tier: "allow" });
    expect(commandsOf("eval", { language: "js", code: 'const a = "bun test OLD"; const b = a.replaceAll("OLD", "src"); Bun.spawn(["bash", "-lc", b])' })).toEqual(["bash -lc 'bun test src'"]);
    expect(evalCode('const script = "rm -rf ~"; Bun.spawn(["bash", "-c", script])').tier).toBe("deny");
    expect(evalCode('const a = "ls"; const b = a.replaceAll("ls", "rm -rf /"); Bun.spawn(["bash", "-c", b])').tier).toBe("deny");
    expect(evalCode("const cmd = 'git push origin main'; execSync(cmd)").tier).toBe("escalate");
    expect(evalCode("const s = String.raw`git push`; Bun.spawn(['sh', '-c', s])").tier).toBe("escalate");
  });

  it("a_helper_that_runs_its_parameters_is_judged_by_each_call", () => {
    // The OmO corpus: `const run = async (args) => { … Bun.spawn(args, { cwd: repo }) … }; await run(["git", "status"])`.
    const helper = (calls: string, spawn = "Bun.spawn(args, { cwd: repo, stdout: 'pipe' })") =>
      `const repo = '/work/proj';\nconst run = async (args) => {\n  const child = ${spawn};\n  return await new Response(child.stdout).text();\n};\n${calls}`;
    expect(evalCode(helper('print(await run(["git", "status", "--short"])); print(await run(["bun", "test"]));')).tier).toBe("allow");
    expect(commandsOf("eval", { language: "js", code: helper('await run(["git", "log", "-1"])') })).toEqual(["cd /work/proj && git log -1"]);
    expect(evalCode(helper('await run(["git", "status"]); await run(["git", "push", "origin", "main"])')).tier).toBe("escalate");
    expect(evalCode(helper('await run(["rm", "-rf", "/"])')).tier).toBe("deny");
    const twoParams = 'function run(command, args) { return Bun.spawnSync([command, ...args], { stdout: "pipe" }); }\nrun("bun", ["test", "a.test.ts"]);\nrun("git", ["diff", "--stat"]);';
    expect(evalCode(twoParams).tier).toBe("allow");
    expect(evalCode("const run = async (args) => { const child = Bun.spawn(args); return { args, child }; };\nawait run(['git', 'status']);").tier).toBe("allow");
    expect(evalCode("const run = async (args) => { for (;;) { Bun.spawn(args); args.push('-rf', '/'); } };\nawait run(['rm']);").tier).not.toBe("allow");
    expect(evalCode(twoParams.replace('"diff", "--stat"', '"reset", "--hard"')).tier).toBe("escalate");
    // the cwd a call passes in is kept (`{ cwd }` shorthand)
    expect(evalCode("const run = (args, cwd) => { return Bun.spawnSync(args, { cwd }) };\nrun(['rm', '-rf', '*'], '/');").tier).toBe("deny");
    for (const code of [
      helper("await run(list)"),
      helper('await run(["git", "status"]); [["rm", "-rf", "/"]].map(run)'),
      helper(""),
      "const run = async (args) => { args = ['rm', '-rf', '/']; return Bun.spawn(args) };\nawait run(['ls']);",
      "const run = async (args) => { args.push('--force'); return Bun.spawn(args) };\nawait run(['git', 'push']);",
      "const run = async (args) => Bun.spawn(args);\nawait run(['ls']);",
      "const run = async (args) => { return Bun.spawn(args) };\nconst run2 = run;\nawait run(['ls']);",
      "const run = async (args) => { return Bun.spawn(args) };\nawait run(['ls']);\neval('x');",
    ]) expect(evalCode(code).tier, code).not.toBe("allow");
  });

  it("a_const_that_may_be_rebound_or_rewritten_is_never_its_literal", () => {
    for (const code of [
      "const dir = '/tmp/x'; function f(dir) { execSync('rm -rf ' + dir) }",
      "const cmd = 'ls'; ['rm -rf /'].forEach((cmd) => execSync(cmd))",
      "const cmd = 'ls'; ['rm -rf /'].forEach(cmd => execSync(cmd))",
      "const cmd = 'ls'; function f(...cmd) { Bun.spawn(cmd) } f('rm', '-rf', '/')",
      "const cmd = 'ls'; try { x() } catch (cmd) { execSync(cmd) }",
      "const cmd = 'ls'; for (const cmd of ['rm -rf /']) execSync(cmd)",
      "const cmd = 'ls'; { const { cmd } = { cmd: 'rm -rf /' }; execSync(cmd) }",
      "const cmd = 'ls'; const o = { run(cmd) { execSync(cmd) } }",
      "const cmd = 'ls'; eval('x'); execSync(cmd)",
      "let cmd = 'ls'; cmd = 'rm -rf /'; execSync(cmd)",
      "var cmd = 'ls'; execSync(cmd)",
      "const a = 'ls'; const b = a.replace('ls', '$&; rm -rf /'); execSync(b)",
      "const a = 'ls'; const b = a.replace(/ls/, 'rm -rf /'); execSync(b)",
      "const a = 'ls'; const b = a.replaceAll('ls', x); execSync(b)",
      "const a = `echo ${x}; rm -rf ~`; const b = a.replace('rm -rf ~', 'echo hi'); execSync(b)",
      "const s = `ls ${a ? 'x' : 'y'}`; execSync(s)",
    ]) expect(evalCode(code).tier, code).not.toBe("allow");
  });

  it("an_interpolation_that_is_not_a_plain_value_is_still_unparsed", () => {
    for (const code of ['execSync(`ls ${ok ? "a" : "b"}`)', "execSync(`ls ${a ? b : c}`)", "execSync('ls ' + a ? b : c)", "execSync(`ls ${`${x}`}`)"]) {
      expect(evalCode(code).reasons, code).toContain("unparsed-eval: код вызывает процесс, команду которого не прочитать статически");
    }
  });

  it("a_remote_exec_remote_command_with_a_computed_value_escalates", () => {
    for (const code of [
      "execSync(`remote-exec exec ${cmd}`)",
      'execSync(`remote-exec exec "cd /srv && ${cmd}"`)',
      "execSync(`remote-exec exec bash <<'EOF'\n${script}\nEOF`)",
      'execSync(`remote-exec exec "docker compose down ${flags}"`)',
      'execSync(`remote-exec exec "cd /srv && psql -c \\"${sql}\\""`)',
    ]) {
      const verdict = evalCode(code);
      expect(verdict.tier, code).toBe("escalate");
      expect(verdict.reasons.join(" "), code).toContain("remote-unknown");
    }
    expect(evalCode("const svc = 'api'; execSync(`remote-exec exec \"docker compose logs ${svc}\"`)").tier).toBe("allow");
    expect(evalCode('execSync(`remote-exec exec "docker compose ps"`)').tier).toBe("allow");
  });

  it("the_home_and_working_directory_of_the_eval_are_HOME_and_PWD", () => {
    for (const code of [
      "execSync(`rm -rf ${os.homedir()}`)",
      "execSync(`rm -rf ${process.env.HOME}/`)",
      "execSync('rm -rf ' + homedir())",
      "await Bun.$`rm -rf ${Bun.env.HOME}`",
    ]) expect(evalCode(code).tier, code).toBe("deny");
    expect(evalCode("execSync(`docker run -v ${os.homedir()}:/h alpine sh`)").reasons.join(" ")).toContain("docker-mount");
    const inHome = classify(
      { tool_name: "eval", tool_input: { language: "js", code: "execSync(`docker run -v ${process.cwd()}:/w alpine sh`)" }, cwd: "/Users/me", home: "/Users/me" },
      defaults,
    );
    expect(inHome.reasons.join(" ")).toContain("docker-mount");
  });

  it("a_computed_cwd_option_makes_a_relative_delete_target_unknown", () => {
    for (const code of [
      "await tool.bash({ command: 'rm -rf build', cwd: dir })",
      "execSync('rm -rf build', { cwd: dir })",
      "spawnSync('find', ['.', '-delete'], { cwd: dir })",
      "Bun.spawn(['rm', '-r', 'out'], { cwd })",
      "await Bun.$`rm -rf build`.cwd(dir)",
    ]) expect(evalCode(code), code).toMatchObject({ tier: "escalate" });
    expect(evalCode("execSync('rm -rf *', { cwd: '/' })").tier).toBe("deny");
    expect(evalCode("execSync('npm test', { cwd: dir })").tier).toBe("allow");
    expect(evalCode("await tool.bash({ command: 'ls -la', cwd: root })").tier).toBe("allow");
  });

  it("shows an interpolated value as ${…} in the extracted commands", () => {
    expect(commandsOf("eval", { language: "js", code: "await Bun.$`cat ${file}`" })).toEqual(["cat ${…}"]);
  });

  it("gives an eval and its inner bash call the same key when they carry the same command", () => {
    const inner = bash("git push origin main");
    const outer = evalCode('await tool.bash({ command: "git push origin main" })');
    expect(outer.key).toBe(inner.key);
    expect(outer.normalized).toBe(inner.normalized);
  });
});

describe("normalization and key", () => {
  it("normalizes git global options and is stable", () => {
    expect(bash("git -C repo --no-pager push origin").normalized).toBe("git push origin");
    expect(bash('bash -lc "cd x && git status"').normalized).toBe("cd x ; git status");
    expect(bash("git push").normalized).toBe(bash("git -C z push").normalized);
    expect(bash("git push").key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("key keeps the options that normalization drops (no cache/dedupe collisions)", () => {
    const keys = [
      "git reset --hard HEAD",
      "git -C /other reset --hard HEAD",
      "git --git-dir=/x/.git reset --hard HEAD",
      "git -c core.hooksPath=/tmp/h reset --hard HEAD",
      "FOO=1 git reset --hard HEAD",
      "git reset --hard 'HEAD'",
    ].map((command) => bash(command).key);
    expect(new Set(keys.slice(0, 5)).size).toBe(5);
    expect(keys[5]).toBe(keys[0]);
  });

  it("key depends on cwd and command", () => {
    const other = classify({ tool_name: "bash", tool_input: { command: "git push" }, cwd: "/else" }, defaults);
    expect(other.key).not.toBe(bash("git push").key);
    expect(bash("git pull").key).not.toBe(bash("git push").key);
  });

  it("allows read tools and denies a bash call without its command", () => {
    expect(classify({ tool_name: "read", tool_input: { path: "/x" }, cwd: CWD }, defaults).tier).toBe("allow");
    expect(classify({ tool_name: "bash", tool_input: {}, cwd: CWD }, defaults).tier).toBe("deny");
  });

  it("is fast for typical commands", () => {
    bash("git status");
    const started = performance.now();
    for (let run = 0; run < 100; run += 1) bash('cd /work && git -C x log --oneline | head -5 && echo "done $(date)"');
    expect((performance.now() - started) / 100).toBeLessThan(30);
  });
});

describe("rules validation", () => {
  it("classify_refuses_rules_with_a_bad_regex", () => {
    const withEscalate = (patterns: string[]) => ({ ...defaults, builtinEscalate: [{ id: "x", label: "x", patterns }] });
    expect(() => classify({ tool_name: "bash", tool_input: { command: "ls" }, cwd: CWD }, withEscalate(["[a-"]))).toThrow(/regex/);
  });
});

describe("tuned_on_the_real_command_corpus", () => {
  it.each([
    ["cat <<'EOF'\nrm -rf ~\nEOF", "allow"],
    ["echo $((1+2))", "allow"],
    ["sudo pfctl -s rules", "allow"],
    ["remote-exec exec 'docker system prune -f'", "escalate"],
    ["remote-exec exec 'rm -rf /'", "deny"],
     ["sshpass -p x ssh dev@192.168.1.50 hostname", "allow"],
    ["docker run -v ~/.omo:/h alpine true", "escalate"],
  ])("tuned_%s", (command, tier) => {
    expect(bash(command).tier).toBe(tier);
  });

  it.each([
    "git commit -q -F - <<'MSG'\nfix: never git push from here\nMSG",
    "git commit -m \"$(cat <<'EOF'\nfix: tidy the parser\nEOF\n)\"",
    "tee out.txt <<'EOF'\nrm -rf ~ is text here\nEOF",
    "grep -c push <<'EOF'\ngit push\nEOF",
    "jq . <<'EOF'\n{\"cmd\": \"rm -rf /\"}\nEOF",
    "sed -n '1p' <<'EOF'\ngit push\nEOF",
    "python3 -c 'import json, sys; print(json.load(sys.stdin))'",
    "command -v rm",
    "nice -n 10 make -j4",
    "timeout 60 npm test",
    "find . -name '*.pyc' | xargs rm -f",
    "ssh -o ConnectTimeout=5 dev@10.0.0.5 uptime",
    "python3 - <<'PY'\nimport pathlib\nprint('git push')\nPY",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'status'])\nPY",
    "cat > gen.sh <<EOF\necho \\$(date) \\`uname\\`\nEOF",
    "cat <<EOF\nbuilt at $(date)\nEOF",
    "bash <<'EOF'\nls -la\nEOF",
    "remote-exec exec bash <<'EOF'\ndocker ps\nEOF",
    "ssh dev@10.0.0.5 'ls /tmp && df -h'",
    "sshpass -p x ssh dev@10.0.0.5 <<'EOF'\nuptime\nEOF",
    "remote-exec exec 'rm -rf build ./dist node_modules/.cache'",
    "remote-exec exec \"psql -c 'DELETE FROM jobs WHERE id = 3 AND done'\"",
    "cat ~/.ssh/config 2>/dev/null | head",
    "ssh-keygen -l -f ~/.ssh/known_hosts",
    "tail -5 ~/.ssh/known_hosts",
    "docker compose run -v ./src:/src app npm test",
    "find . -name '*.pyc' -delete",
    "GIT_SSH_COMMAND='ssh -i /tmp/deploy_key' git fetch",
    "cat > notes.md <<'EOF'\n$(git push) `rm -rf /`\nEOF\ngit status",
    "T=$(( $(date +%s) + 480 )); until [ \"$(date +%s)\" -ge \"$T\" ]; do sleep 20; done",
    "CA=/opt/tools/ca; $CA live && \"$CA\" -p work tabs",
    "W=/opt/tools; $W/run.sh --check",
    "D=/tmp/build-x; rm -rf \"$D\"",
    "sudo -n pfctl -s rules 2>&1 | head",
     "sudo launchctl list | grep myapp",
    "sudo launchctl print system/com.example.x",
    "sudo lsof -i :8080",
    "sudo log show --last 5m --predicate 'process == \"x\"'",
    "sudo dmesg",
    "sudo -n pfctl -a vpn -t direct_hosts -T show 2>/dev/null",
    "sudo pfctl -nvf /tmp/anchor.conf",
    "sudo pfctl -sr",
    "swift build --disable-sandbox",
    "swift test --disable-sandbox --filter X",
    "swift run --disable-sandbox tool",
    "xcodebuild -scheme App -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePackageSandbox=YES build",
    "remote-exec exec 'docker ps' && remote-exec exec 'git reset --hard'",
    "remote-exec exec 'rm -rf platform/web/node_modules && echo cleaned'",
    "remote-exec exec \"psql -c 'DELETE FROM jobs WHERE id = 3'\"",
    "cat ~/.ssh/config | head -20",
    "grep -c . ~/.ssh/known_hosts",
    "FILES=(${(f)\"$(grep -rl old .)\"}) && print -l $FILES",
    "arr=(a b c); echo ${arr[1]}",
  ])("allows ordinary work: %s", (command) => {
    expect(bash(command)).toMatchObject({ tier: "allow", reasons: [] });
  });

  it.each([
    "bash <<'EOF'\nrm -rf ~\nEOF",
    "rm -rf $HOME",
    "rm -rf \"$HOME\"",
    "rm -rf ~/",
    "remote-exec exec 'mkfs.ext4 /dev/sda'",
  ])("denies: %s", (command) => {
    expect(bash(command).tier).toBe("deny");
  });

  it.each([
    "sh <<EOF\ngit push\nEOF",
    "python3 - <<'PY'\nimport subprocess\nprint('git push')\nPY",
    "cat <<EOF | sh\nls\nEOF",
    "echo $(( $(git push) + 1 ))",
    "rm -rf \"$UNSET_DIR/\"",
    "X=$(cat cmd.txt); $X",
    "G=/usr/bin/git; $G push",
    "if [ -n \"$A\" ]; then D=/; else D=/tmp/x; fi; rm -rf $D",
    "D=/tmp/x; for D in / /tmp; do rm -rf $D; done",
    "sudo pfctl -F all",
    "sudo pfctl -s rules && sudo pfctl -d",
    "sudo pfctl -a vpn -t hosts -T add 10.0.0.1",
    "sudo pfctl -a vpn -f /tmp/anchor.conf",
    "sudo pfctl -n -F all",
    "sudo launchctl bootout system/com.example.x",
    "sudo lsof -i :80 > /etc/hosts",
    "remote-exec exec 'rm -rf /srv/app/data'",
    "remote-exec exec 'cd /srv && rm -rf app'",
    "remote-exec exec 'rm -rf ../other'",
    "remote-exec exec 'rm -rf *'",
    "remote-exec exec 'rm -rf ./build \"$OUT\"'",
    "remote-exec exec \"psql -c 'DELETE FROM jobs'\"",
    "echo 'Host x' >> ~/.ssh/config",
    "tee -a ~/.ssh/authorized_keys < key.txt",
    "sed -i '' 's/a/b/' ~/.ssh/config",
    "arr=($(git push))",
    "remote-exec exec \"docker rm -f web\"",
    "remote-exec exec \"docker rmi app:latest\"",
    "remote-exec exec \"docker volume prune -f\"",
    "remote-exec exec \"psql -c 'DROP TABLE users'\"",
    "remote-exec exec \"psql -c 'delete from users'\"",
    "remote-exec exec 'pkill -f worker'",
    "remote-exec exec 'kill -9 1234'",
    "sshpass -p x ssh root@203.0.113.50 reboot",
    "docker run -v $HOME:/host alpine sh",
    "docker run -v /:/host alpine sh",
    "docker run --volume ~/Library/LaunchAgents:/la alpine sh",
    "docker create -v ~:/h alpine",
    "docker run --mount type=bind,source=/,target=/host alpine",
    "docker run -v=/Users:/u alpine",
  ])("escalates: %s", (command) => {
    expect(bash(command).tier).toBe("escalate");
  });

  it("docker mounts of a project dir or a named volume stay allowed", () => {
    for (const command of ["docker run -v $PWD:/src node:20 npm test", "docker run -v ./data:/data postgres", "docker run -v pgdata:/var/lib/postgresql/data postgres", "docker run -v /tmp/x:/x alpine"]) {
      expect(bash(command).tier).toBe("allow");
    }
  });

  it("the agent dir passed in the call is protected from docker mounts", () => {
    const input = { tool_name: "bash", tool_input: { command: "docker run -v /opt/agents/env1:/a alpine" }, cwd: CWD, agent_dir: "/opt/agents/env1/agent" };
    expect(classify(input, defaults).tier).toBe("escalate");
  });
});

describe("custom ask rules", () => {
  const rules = { ...defaults, askCustom: ["terraform destroy", "kubectl delete*"] };
  it("a_line_without_a_star_matches_as_whole_words_and_a_star_line_as_a_glob", () => {
    expect(bash("cd infra && terraform destroy -auto-approve", rules).tier).toBe("escalate");
    expect(bash("terraform destroyer", rules).tier).toBe("allow");
    expect(bash("kubectl delete pod x", rules).tier).toBe("escalate");
    expect(bash("echo kubectl delete pod", rules).tier).toBe("allow");
    expect(bash('remote-exec exec "terraform destroy"', rules).tier).toBe("escalate");
  });

  it("a_group_switched_off_stops_escalating", () => {
    const quiet = { ...defaults, groups: { ...defaults.groups, "git-push": false, "external-ip": false } };
    expect(bash("git push", quiet).tier).toBe("allow");
    expect(bash("curl 8.8.8.8", quiet).tier).toBe("allow");
    expect(bash("git reset --hard", quiet).tier).toBe("escalate");
  });
});

describe("tool inputs (F7)", () => {
  const fieldsF7 = (input: string) => ({ bash_id: "b1", input, submit: true });
  const call = (tool_name: string, tool_input: object) => classify({ tool_name, tool_input, cwd: CWD }, defaults);

  it("bash_input_and_monitor_are_classified_like_bash", () => {
    expect(call("bash_input", fieldsF7("git push")).tier).toBe("escalate");
    expect(call("monitor", { action: "create", type: "command", command: "git push", description: "x" }).tier).toBe("escalate");
    expect(call("monitor", { command: "rm -rf /", description: "x" }).tier).toBe("deny");
  });

  it("commands_of_each_tool", () => {
    expect(commandsOf("bash", { command: "ls" })).toEqual(["ls"]);
    expect(commandsOf("bash_input", fieldsF7("git status"))).toEqual(["git status"]);
    expect(commandsOf("bash_input", { bash_id: "b1", keys: ["ctrl+c"] })).toBe("read");
    expect(commandsOf("monitor", { type: "command", command: "tail -f x" })).toEqual(["tail -f x"]);
    expect(commandsOf("monitor", { type: "path", path: "/tmp/x", command: "rm -rf /" })).toBe("read");
    expect(commandsOf("monitor", { action: "rearm", command: "git push" })).toBe("read");
    expect(commandsOf("monitor", { target: "rpc-1" })).toBe("read");
    for (const tool of ["write", "edit", "apply_patch", "multiedit"]) expect(commandsOf(tool, { input: "x" })).toBe("write");
    for (const tool of ["read", "grep", "find", "glob", "ls", "todo", "web_search", "webfetch", "tool_search", "bash_output", "kill_bash", "bash_resize"]) {
      expect(commandsOf(tool, {})).toBe("read");
    }
    expect(commandsOf("fs_write_v2", {})).toBe("unknown-write");
  });

  it("an_unknown_write_like_tool_is_denied_another_unknown_tool_escalates_and_a_read_tool_is_allowed", () => {
    for (const tool of ["fs_write_v2", "Run_Script", "remote_exec", "spawn_process", "shell", "notebook_edit", "patch_file"]) {
      expect(call(tool, {})).toMatchObject({ tier: "deny", reasons: [expect.stringContaining("неизвестный инструмент записи")] });
    }
    expect(call("lsp_hover", {}).tier).toBe("escalate");
    for (const tool of ["ask_user_question", "request_user_input"]) expect(call(tool, { questions: [] }).tier).toBe("allow");
    expect(call("grep", { pattern: "git push" }).tier).toBe("allow");
    expect(call("bash_input", { bash_id: "b1", keys: ["ctrl+c"] }).tier).toBe("allow");
  });

  it("a_command_tool_without_its_command_is_an_invalid_call", () => {
    const invalid = [
      ["bash", {}], ["bash", { command: 5 }], ["bash", "ls"], ["eval", { language: "js" }], ["eval", { language: "js", code: null }],
      ["monitor", { type: "command", description: "x" }], ["monitor", { description: "x" }], ["monitor", "tail -f x"], ["bash_input", { bash_id: "b1", input: 7 }],
    ] as const;
    for (const [tool, input] of invalid) {
      expect([tool, input, commandsOf(tool, input)]).toEqual([tool, input, "invalid"]);
      expect(classify({ tool_name: tool, tool_input: input, cwd: CWD }, defaults)).toMatchObject({ tier: "deny", reasons: [expect.stringContaining("некорректный вызов инструмента")] });
    }
  });

  it("the_eval_cell_controls_run_nothing", () => {
    // OmO 5.1.59 docs/rpc.md: the eval tool's list / peek / stop actions only observe or cancel the session's own cells.
    for (const input of [{ action: "list" }, { action: "peek", cellId: "cell_1", tailBytes: 8192 }, { action: "stop", cellId: "cell_1" }]) {
      expect(call("eval", input).tier).toBe("allow");
    }
    expect(call("eval", { action: "run" }).tier).toBe("deny");
    expect(call("eval", { action: "list", language: "js", code: "execSync('git push')" }).tier).toBe("escalate");
  });

  it("bash_input_keys_that_submit_replay_a_command_from_history", () => {
    for (const input of [{ keys: ["enter"] }, { keys: ["Up", "Return"] }, { keys: ["up"], submit: true }, { keys: ["\r"] }]) {
      expect(commandsOf("bash_input", { bash_id: "b1", ...input })).toBe("replay");
      expect(call("bash_input", { bash_id: "b1", ...input })).toMatchObject({ tier: "escalate", reasons: [expect.stringContaining("повтор команды из истории")] });
    }
    expect(call("bash_input", { bash_id: "b1", keys: ["ctrl+c"] }).tier).toBe("allow");
  });

  it("write_like_names_are_matched_by_token_not_substring", () => {
    for (const tool of ["truncate", "prune", "credit", "rewrite", "rerun_report", "evaluation"]) expect(isUnknownWriteTool(tool)).toBe(false);
    for (const tool of ["fs_write_v2", "runCommand", "shell_exec", "writeFile", "multi-edit", "db.exec", "spawnProcess"]) expect(isUnknownWriteTool(tool)).toBe(true);
    expect(classify({ tool_name: "runCommand", tool_input: {}, cwd: CWD }, defaults).tier).toBe("deny");
    expect(call("credit", {}).tier).toBe("escalate");
  });

  it("mcp_tools_are_allowed_unless_their_name_has_a_write_verb", () => {
    // The real names the user's MCP servers expose (mcp-cache.json): context7 docs lookups, code search, codegraph.
    for (const [tool, input] of [
      ["mcp_codegraph_codegraph_explore", { query: "x" }],
      ["mcp_context7_resolve-library-id", { libraryName: "YClients API", query: "records endpoint" }],
      ["mcp_context7_query-docs", { libraryId: "/vitest-dev/vitest", query: "Vitest 3 custom runner" }],
      ["mcp_context7_get-library-docs", { context7CompatibleLibraryID: "/x/y" }],
      ["mcp_grep_app_searchGitHub", { query: "useEffect" }],
      ["mcp__ast_grep_scan", {}],
      ["mcp_github_get_issue", {}],
      ["mcp_github_listPullRequests", {}],
      ["mcp_codegraph", {}],
      ["mcp_other_codegraph_explore", {}],
      ["mcp_weather_forecast", {}],
    ] as const) expect([tool, call(tool, input).tier]).toEqual([tool, "allow"]);
    for (const tool of [
      "mcp_github_create_issue", "mcp_fs_write_file", "mcp__fs__write_file", "mcp_github_createPullRequest", "mcp_db_execute-sql",
      "mcp_slack_send_message", "mcp_vercel_deploy", "mcp_shell_run", "mcp_github_merge_pull_request", "mcp_fs.delete", "mcp_k8s_killPod",
      "mcp_github_add_issue_comment", "mcp__ast_grep_rewrite",
    ]) expect([tool, call(tool, {}).tier, call(tool, {}).reasons.join(" ")]).toEqual([tool, "escalate", expect.stringContaining("mcp-write")]);
  });

  describe("the real OmO 5.1.59 tool list", () => {
    const tools = JSON.parse(readFileSync(new URL("./fixtures/omo-5.1.59-tools.json", import.meta.url), "utf8"));
    it("no_read_tool_escalates", () => {
      for (const tool of [...tools.readOnly, ...tools.passThrough, ...tools.mcpRead]) expect([tool, call(tool, {}).tier]).toEqual([tool, "allow"]);
    });
    it("every_write_capable_built_in_is_a_command_or_write_tool_or_denied", () => {
      // Every field a command tool reads its command from (bash.command, bash_input.input, monitor.command, eval.code).
      const runs = { command: "x", input: "x", language: "sh", code: "x" };
      for (const tool of tools.writeCapable) {
        const calls = commandsOf(tool, runs);
        expect([tool, Array.isArray(calls) || calls === "write" || call(tool, {}).tier === "deny"]).toEqual([tool, true]);
      }
    });
    it("every_other_built_in_goes_to_the_decider_not_through", () => {
      for (const tool of tools.other) expect([tool, call(tool, {}).tier]).toEqual([tool, "escalate"]);
    });
  });

  it("eval_shell_is_extracted_from_js_and_python", () => {
    expect(commandsOf("eval", { language: "ts", code: "await Bun.$`git status`; await $`ls -la`;" })).toEqual(["git status", "ls -la"]);
    expect(commandsOf("eval", { language: "python", code: 'import subprocess\nsubprocess.run(["git", "push"], check=True)\nos.system("ls")' })).toEqual(["git push", "ls"]);
    expect(commandsOf("eval", { language: "js", code: "return 1 + 1" })).toEqual([]);
    expect(commandsOf("eval", { language: "js", code: "const c = pick(); execSync(c)" })).toBe("unknown-write");
    expect(commandsOf("eval", { language: "python", code: "import subprocess\nsubprocess.run(cmd, shell=True)" })).toBe("unknown-write");
  });

  it("eval_is_classified_by_its_shell", () => {
    const evalIn = (language: string, code: string) => call("eval", { language, summary: "x", code });
    expect(evalIn("ts", "await Bun.$`curl -s http://8.8.8.8/x`").tier).toBe("escalate");
    expect(evalIn("python", 'import os\nos.system("rm -rf /")').tier).toBe("deny");
    expect(evalIn("python", "import subprocess\nsubprocess.check_output(['git', 'push', 'origin'])").tier).toBe("escalate");
    expect(evalIn("python", "import subprocess\nsubprocess.run(args)").tier).toBe("escalate");
    expect(evalIn("python", "print(sum([1, 2]))").tier).toBe("allow");
    expect(evalIn("ts", "await Bun.$`git status`").tier).toBe("allow");
  });
});

describe("known dangerous forms", () => {
  const dangerousForms: string[] = JSON.parse(readFileSync(new URL("./fixtures/dangerous-forms.json", import.meta.url), "utf8"));

  it("every_known_dangerous_form_is_caught", () => {
    expect(dangerousForms.length).toBeGreaterThan(50);
    const missed = dangerousForms.filter((form) => bash(form).tier === "allow");
    expect(missed).toEqual([]);
  });
});

describe("review_fix_round_1 (task 8): bypasses denied, not just escalated", () => {
  it.each([
    "cat <<EOF\n$(rm -rf ~)\nEOF",
    "D=/; rm -rf $D/*",
    "rm -rf //*",
    "rm -rf /./",
    "rm -rf /*/",
    "rm -rf /tmp/../",
    "rm -rf ~/./",
    "sh <<<\"rm -rf ~\"",
    "kubectl exec -i pod -- sh <<'EOF'\nrm -rf /\nEOF",
    "ssh dev@10.0.0.5 bash -s <<'EOF'\nrm -rf /\nEOF",
    "ssh dev@10.0.0.5 'rm -rf /'",
    "find / -delete",
    "GIT_SSH_COMMAND='rm -rf ~' git fetch",
  ])("denies: %s", (command) => {
    expect(bash(command).tier).toBe("deny");
  });
});

describe("review_fix_round_2 (task 8, P25)", () => {
  it.each([
    "rm -rf build /",
    "rm -r /",
    "env -i rm -rf /",
    "nice -n 10 rm -rf /",
    "timeout -s KILL 5 rm -rf ~",
    "stdbuf -oL rm -rf /",
    "find /. -delete",
    "find // -delete",
    "find -L / -delete",
    "ssh dev@10.0.0.5 'find / -delete'",
    "bash /dev/stdin <<'EOF'\nrm -rf ~\nEOF",
    "env -S 'rm -rf /'",
  ])("denies: %s", (command) => {
    expect(bash(command).tier).toBe("deny");
  });

  it("xargs_rm_targets_are_unknown", () => {
    expect(bash("find . -name x | xargs rm -rf").reasons.join(" ")).toMatch(/xargs/);
  });

  it("user_hard_deny_on_another_host_asks_instead_of_denying", () => {
    const rules = { ...defaults, hardDeny: [...defaults.hardDeny, "terraform destroy*"] };
    expect(bash("ssh dev@10.0.0.5 bash -s <<'EOF'\nterraform destroy -auto-approve\nEOF", rules).tier).toBe("escalate");
    expect(bash("remote-exec exec 'terraform destroy -auto-approve'", rules).tier).toBe("escalate");
    expect(bash("docker exec -i app sh <<'EOF'\nterraform destroy\nEOF", rules).tier).toBe("escalate");
    expect(bash("terraform destroy -auto-approve", rules).tier).toBe("deny");
  });

  it("catastrophic_forms_on_another_host_still_deny (P26)", () => {
    for (const command of [
      "ssh dev@10.0.0.5 'rm -rf /'",
      "ssh dev@10.0.0.5 'rm -rf //*'",
      "ssh dev@10.0.0.5 'nice rm -r /tmp/../'",
      "remote-exec exec 'mkfs.ext4 /dev/sda'",
      "remote-exec exec 'dd if=/dev/zero of=/dev/sda'",
      "ssh dev@10.0.0.5 'find /. -delete'",
      "ssh dev@10.0.0.5 'diskutil eraseDisk JHFS+ x disk2'",
      "kubectl exec -i pod -- sh <<'EOF'\nrm -rf /\nEOF",
    ]) expect(bash(command).tier, command).toBe("deny");
  });

  it("an_app_bundle_removed_on_the_vm_is_a_question_locally_a_deny", () => {
     expect(bash("sshpass -p x ssh dev@192.168.1.50 'rm -rf /Applications/X.app'").tier).toBe("escalate");
    expect(bash("rm -rf /Applications/X.app").tier).toBe("deny");
  });

  it("remote_checks_do_not_depend_on_the_editable_allow_rule", () => {
    const rules = { ...defaults, allow: defaults.allow.filter((entry: { id: string }) => entry.id !== "remote-exec") };
    expect(bash("ssh dev@10.0.0.5 'rm -rf /'", rules).tier).toBe("deny");
    expect(bash("ssh dev@10.0.0.5 'docker system prune -af'", rules).tier).toBe("escalate");
    expect(bash("remote-exec exec 'rm -rf /'", rules).tier).toBe("deny");
  });
});

describe("review_fix_round_4 (task 8)", () => {
  it("ansi_c_quotes_do_not_hide_the_rest_of_the_command", () => {
    expect(bash("git commit -m $'don\\'t\\nbody' && git push").tier).toBe("escalate");
    expect(bash("echo $'it\\'s' && rm -rf /").tier).toBe("deny");
    expect(bash("echo $'tab\\there' $'x\\'y'").tier).toBe("allow");
  });

  it("container_argv_is_classified_in_the_container", () => {
    expect(bash("docker exec c sh -c 'rm -rf /'").tier).toBe("deny");
    expect(bash("kubectl exec pod -- rm -rf /").tier).toBe("deny");
    expect(bash("docker exec app ls").tier).toBe("allow");
    expect(bash("docker exec -it app psql -c 'select 1'").tier).toBe("allow");
  });

  it.each(["cd / && rm -rf *", "cd ~ && rm -rf *", "cd $HOME && rm -rf *", "cd /;rm -rf ./*", "cd / && find . -delete"])(
    "relative_targets_follow_cd: %s",
    (command) => expect(bash(command).tier).toBe("deny"),
  );

  it("relative_targets_after_cd_into_a_project_stay_allowed", () => {
    expect(bash("cd /work/proj && rm -rf build dist").tier).toBe("allow");
  });

  it.each([
    "git commit -m \"$(cat <<'EOF'\nfix: stop the git push loop\n\nsudo rm was the culprit\nEOF\n)\"",
    "git commit -F - <<'EOF'\nfix: never git push here\nEOF",
    "gh pr create --title x --body \"$(cat <<'EOF'\n## Summary\n- git push is now guarded\nEOF\n)\"",
    // Was a round-2 dangerous form; round 4 (item 4) rules this exact shape data: the body only ever reaches cat.
    "git commit -m \"$(cat <<'EOF'\nrm -rf ~\nEOF\n)\"",
  ])("the_standard_commit_heredoc_is_data: %s", (command) => {
    expect(bash(command)).toMatchObject({ tier: "allow", reasons: [] });
  });

  it("an_unquoted_or_extended_cat_substitution_still_runs", () => {
    expect(bash("git commit -m \"$(cat <<EOF\n$(git push)\nEOF\n)\"").tier).toBe("escalate");
    expect(bash("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n) $(git push)\"").tier).toBe("escalate");
  });
});
