// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { pkgInstall } from "../distro.js";

/**
 * Container runtimes: is Podman or Docker installed, and is it usable?
 * Podman is daemonless, so "usable" means `podman info` succeeds; Docker
 * needs its daemon running. Read-only checks only (command -v / systemctl
 * is-active / podman info), and non-systemd hosts are never guessed about.
 */
export const containers = defineCheck({
  id: "containers",
  title: "Container runtimes",
  category: "software",
  async run(ctx) {
    const findings = [];
    const install = (tool) => pkgInstall(ctx.dist, tool);

    const podmanRes = await ctx.run("command -v podman 2>/dev/null");
    const dockerRes = await ctx.run("command -v docker 2>/dev/null");
    const podmanPath = podmanRes.stdout.trim();
    const dockerPath = dockerRes.stdout.trim();

    if (!podmanPath && !dockerPath) {
      findings.push(finding({
        severity: "info",
        code: "containers/none",
        title: "No container runtime installed",
        detail: "Neither Podman nor Docker is installed. Containers are optional — install one if you want to run containerized applications.",
        evidence: "podman: not found\ndocker: not found",
        fix: `${install("podman")}. Podman is daemonless and works with rootless containers out of the box.`,
        confidence: "high",
      }));
      return findings;
    }

    const ready = [];
    if (dockerPath) {
      const act = await ctx.run("systemctl is-active docker 2>/dev/null");
      const st = act.stdout.trim();
      if (st === "active") {
        ready.push("docker");
      } else if (st === "inactive") {
        findings.push(finding({
          severity: "medium",
          code: "containers/docker-stopped",
          title: "Docker daemon is not running",
          detail: "Docker is installed but its daemon is stopped, so `docker` commands fail. This is usually just a service that is not enabled at boot.",
          evidence: `docker: ${dockerPath}\nsystemctl docker: ${st}`,
          fix: "Start it with `sudo systemctl enable --now docker`.",
          confidence: "high",
        }));
      }
      // "unknown" (non-systemd) or "failed" → do not speculate.
    }

    if (podmanPath) {
      const info = await ctx.run("podman info >/dev/null 2>&1 && echo ok || echo fail");
      if (/^ok\s*$/.test(info.stdout)) {
        ready.push("podman");
      } else {
        findings.push(finding({
          severity: "medium",
          code: "containers/podman-failed",
          title: "Podman cannot run containers",
          detail: "`podman info` failed, so Podman cannot manage containers right now. This is usually a storage or user-namespace problem.",
          evidence: `podman: ${podmanPath}\npodman info: ${info.stdout.trim()}`,
          fix: "Inspect `podman info` output and `journalctl --user -n 50`, and make sure user namespaces are enabled (`sysctl kernel.unprivileged_userns_clone` on some distros).",
          confidence: "medium",
        }));
      }
    }

    if (ready.length > 0) {
      // Scan every container for ones that died or are stuck restarting — the
      // classic "green dashboard, dead service" trap. `ps -a` is read-only.
      const oom = [];
      const dead = [];
      const restarting = [];
      for (const rt of ready) {
        const res = await ctx.run(
          rt === "podman"
            ? "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null"
            : "docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null"
        );
        if (!res.ok) continue;
        for (const l of lines(res.stdout)) {
          const [name, ...rest] = l.split(/\s+/);
          if (!name) continue;
          const status = rest.join(" ");
          const exited = status.match(/Exited \((\d+)\)/);
          if (/restarting|backoff/i.test(status)) {
            restarting.push(name);
          } else if (exited) {
            const code = parseInt(exited[1], 10);
            // 128 + signal: 143 is SIGTERM and 130 is SIGINT — exactly what
            // `podman stop`, `systemctl stop` and an orderly shutdown send. A
            // container that stopped when it was told to stopped cleanly, and
            // this check is not a monitor: flagging it put a medium finding on
            // every machine with a deliberately stopped container.
            const deliberateStop = code === 143 || code === 130;
            if (code === 137) oom.push(name); // SIGKILL — the OOM-kill signature
            else if (code !== 0 && !deliberateStop) dead.push(`${name} (exit ${code})`);
          } else if (/^created\b/i.test(status)) {
            dead.push(`${name} (created, never started)`);
          }
        }
      }

      if (oom.length > 0) {
        findings.push(finding({
          severity: "high",
          code: "containers/oom",
          title: `${oom.length} container${oom.length > 1 ? "s" : ""} killed by out-of-memory`,
          detail: `These containers exited with code 137 (SIGKILL from the OOM killer): ${oom.join(", ")}. A container dying this way usually means it hit a memory limit, not a code bug — and a crashed container behind a green "running" status is exactly the failure monitoring misses.`,
          evidence: oom.map((n) => `${n}\texit 137 (OOM)`).join("\n"),
          fix: `Check memory pressure with \`podman stats\` / \`docker stats\`, then raise the container's memory limit or fix the leak. Logs: \`${ready[0]} logs ${oom[0]}\`.`,
          confidence: "high",
        }));
      } else if (dead.length > 0) {
        findings.push(finding({
          severity: "medium",
          code: "containers/dead",
          title: `${dead.length} container${dead.length > 1 ? "s" : ""} exited`,
          detail: `These containers are not running and did not exit cleanly: ${dead.join(", ")}. Something inside them failed — a bad config, a missing volume, or a crash.`,
          evidence: dead.join("\n"),
          fix: `Inspect the failure with \`${ready[0]} logs ${dead[0].split(" ")[0]}\`, then restart with \`${ready[0]} start ${dead[0].split(" ")[0]}\`.`,
          confidence: "high",
        }));
      } else if (restarting.length > 0) {
        findings.push(finding({
          severity: "medium",
          code: "containers/restarting",
          title: `${restarting.length} container${restarting.length > 1 ? "s" : ""} stuck restarting`,
          detail: `These containers are in a restart loop: ${restarting.join(", ")}. They keep crashing and the runtime keeps bringing them back — they are never actually up.`,
          evidence: restarting.join("\n"),
          fix: `Find the crash with \`${ready[0]} logs ${restarting[0]}\` and fix the root cause (bad config, missing dependency, OOM).`,
          confidence: "high",
        }));
      }
    }

    if (ready.length > 0 && findings.length === 0) {
      findings.push(finding({
        severity: "info",
        code: "containers/ok",
        title: "Container runtimes are ready",
        detail: `${ready.join(" and ")} can run containers.`,
        evidence: `${ready.join(", ")}: usable`,
        fix: null,
        confidence: "high",
      }));
    }
    return findings;
  },
});
