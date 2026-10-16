// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { pkgInstall } from "../distro.js";

/**
 * Audio state: is a sound server (PipeWire or PulseAudio) running, and is
 * there a real output device? Silent on servers — a headless box has no
 * audio by design, so this check only applies to desktops and laptops.
 * Everything is read-only (pgrep / pactl), with graceful degradation when
 * pactl is missing.
 */
export const audio = defineCheck({
  id: "audio",
  title: "Audio (PipeWire / PulseAudio)",
  category: "hardware",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];
    const up = (res) => /^up\s*$/.test(res.stdout);
    const pipewire = await ctx.run("pgrep -x pipewire >/dev/null 2>&1 && echo up || echo down");
    const pwPulse = await ctx.run("pgrep -x pipewire-pulse >/dev/null 2>&1 && echo up || echo down");
    const pulse = await ctx.run("pgrep -x pulseaudio >/dev/null 2>&1 && echo up || echo down");
    const serverUp = up(pipewire) || up(pwPulse) || up(pulse);

    if (!serverUp) {
      const install = pkgInstall(ctx.dist, "pipewire pipewire-pulse wireplumber");
      findings.push(finding({
        severity: "medium",
        code: "audio/no-server",
        title: "No sound server is running",
        detail: "Neither PipeWire nor PulseAudio is running, so the system has no sound. This is usually a missing or disabled audio stack.",
        evidence: `pipewire: ${pipewire.stdout.trim()}\npipewire-pulse: ${pwPulse.stdout.trim()}\npulseaudio: ${pulse.stdout.trim()}`,
        fix: (ctx.dist?.init || "systemd") === "systemd"
          ? `${install}, then start it with \`systemctl --user enable --now pipewire pipewire-pulse wireplumber\`.`
          : `${install}, then start the PipeWire services for the session (there is no per-user systemd instance on this init system).`,
        confidence: "high",
      }));
      return findings;
    }

    // A sound server is up. Is there a real output device? (auto_null is the
    // dummy sink PipeWire creates when nothing else exists.)
    const pactl = await ctx.run("command -v pactl >/dev/null 2>&1 && echo yes || echo no");
    if (!/^yes\s*$/.test(pactl.stdout)) {
      findings.push(finding({
        severity: "info",
        code: "audio/sinks-skipped",
        title: "Audio output devices not checked",
        detail: "A sound server is running, but `pactl` is not installed, so we could not verify there is a real output device.",
        evidence: "pactl: not found",
        fix: "Install pulseaudio-utils (or pipewire-utils) if you want this check to verify output devices.",
        confidence: "high",
      }));
      return findings;
    }

    const sinks = await ctx.run("pactl list sinks short 2>/dev/null");
    const real = lines(sinks.stdout).filter((l) => !/auto_null/.test(l));
    if (real.length === 0) {
      findings.push(finding({
        severity: "medium",
        code: "audio/no-output",
        title: "No audio output device detected",
        detail: "A sound server is running, but there is no real output device — only the dummy auto_null sink. Sound is broken even though the daemon is up.",
        evidence: `sinks:\n${sinks.stdout.trim() || "(none)"}`,
        fix: "Check that a sound card exists (`lspci | grep -i audio`) and that its driver is loaded (`lsmod | grep snd`). If it is a USB device, try unplugging and replugging it.",
        confidence: "medium",
      }));
    } else {
      findings.push(finding({
        severity: "info",
        code: "audio/ok",
        title: "Audio is working",
        detail: "A sound server is running and at least one real output device is available.",
        evidence: `sinks:\n${real.join("\n")}`,
        fix: null,
        confidence: "high",
      }));
    }
    return findings;
  },
});
