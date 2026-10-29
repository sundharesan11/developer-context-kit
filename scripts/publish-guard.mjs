// U47 (KTD8, R6): the prepublishOnly guard. npm publish from a folder runs it first. It refuses unless the publish runs
// in GitHub Actions or the owner sets DEVTWIN_ALLOW_LOCAL_PUBLISH=1 on purpose. It only stops accidents: the npm setting
// that disallows tokens is the real control, and only the release workflow has a trusted publisher.
const actions = process.env.GITHUB_ACTIONS === "true", override = process.env.DEVTWIN_ALLOW_LOCAL_PUBLISH === "1";
if (actions || override) {
  process.stdout.write(JSON.stringify({ ok: true, via: actions ? "github-actions" : "local-override" }) + "\n");
} else {
  process.stderr.write("devtwin publishes only from the release workflow (.github/workflows/release.yml). Push a v* tag instead. To publish from this machine on purpose, set DEVTWIN_ALLOW_LOCAL_PUBLISH=1.\n");
  process.stdout.write(JSON.stringify({ ok: false, error: "LOCAL_PUBLISH_REFUSED" }) + "\n");
  process.exitCode = 1;
}
