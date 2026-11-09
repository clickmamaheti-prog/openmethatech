// Publish @methatech-cli/cli to npm via direct curl PUT (npm client ECONNRESETs).
// Usage: node scripts/publish-curl.mjs <tarball.tgz> <npmrc-file>
// The npmrc file must contain //registry.npmjs.org/:_authToken=<surrogate>.
// No secrets are stored in this file.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const [tarballPath, npmrcPath] = process.argv.slice(2);
if (!tarballPath || !npmrcPath) {
  console.error("usage: node scripts/publish-curl.mjs <tarball.tgz> <npmrc-file>");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tarball = fs.readFileSync(tarballPath);
const shasum = crypto.createHash("sha1").update(tarball).digest("hex");
const tarballName = `${pkg.name.split("/")[1]}-${pkg.version}.tgz`;

const npmrc = fs.readFileSync(npmrcPath, "utf8");
const m = npmrc.match(/_authToken=(\S+)/);
if (!m) {
  console.error("no _authToken in npmrc");
  process.exit(2);
}
const token = m[1];

const versionDoc = { ...pkg };
delete versionDoc.scripts;
versionDoc.dist = {
  shasum,
  tarball: `https://registry.npmjs.org/${pkg.name}/-/${tarballName}`,
};

const payload = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  "dist-tags": { latest: pkg.version },
  versions: { [pkg.version]: versionDoc },
  _attachments: {
    [tarballName]: {
      content_type: "application/octet-stream",
      data: tarball.toString("base64"),
      length: tarball.length,
    },
  },
};

fs.writeFileSync("/tmp/mt-publish-payload.json", JSON.stringify(payload));
console.log(`tarball ${tarballName}: ${tarball.length} bytes, shasum ${shasum}`);

const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
const out = execFileSync(
  "curl",
  [
    "-sS", "-w", "\nHTTP:%{http_code}\n",
    "--max-time", "300",
    "-X", "PUT",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json",
    "--data-binary", "@/tmp/mt-publish-payload.json",
    url,
  ],
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);
console.log(out);
