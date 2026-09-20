// Repository-owned checks. Failures become GitHub annotations so correction
// agents receive the actual diagnostic output through the Checks API.
const checks = [
  ["Type checking", ["bun", "run", "typecheck"]],
  ["Backend tests", ["bun", "test", "tests"]],
  ["Build and browser acceptance", ["bun", "run", "test:ui"]],
] as const;
for (const [name, command] of checks) {
  console.log(`::group::${name}`);
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stdout + "\n" + stderr;
  console.log(output);
  console.log("::endgroup::");
  if (status !== 0) {
    const diagnostic = output
      .slice(-12000)
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::error title=${name}::${diagnostic}`);
    process.exit(status);
  }
}
export {};
