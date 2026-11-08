import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { theme } from "../theme.js";
import { formatUsd } from "../cost.js";
import { TOPUP_URL, LOGIN_URL } from "../config.js";
import type { Subscription } from "../api.js";

interface AccountScreenProps {
  subscription: Subscription | null;
  usedUsd: number | null;
  keySource: "env" | "file";
}

/**
 * Account screen. Shows only what the Bearer API can prove:
 * spending limit + used + derived balance. Email and free-credit balance
 * are NOT available through any Bearer endpoint, so they are not invented
 * here — the panel link is shown instead.
 */
export default function AccountScreen({ subscription, usedUsd, keySource }: AccountScreenProps) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
  });

  const limit = subscription?.hardLimitUsd ?? null;
  const balance = limit !== null && usedUsd !== null ? Math.max(0, limit - usedUsd) : null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          MethaTech
        </Text>
        <Text color={theme.muted}> · account</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.muted}>Signed in </Text>
          <Text color={theme.text} bold>
            yes
          </Text>
          <Text color={theme.dim}> (key dari {keySource === "env" ? "METATECH_API_KEY" : "file tersimpan"})</Text>
        </Box>
        <Box>
          <Text color={theme.muted}>Spending limit </Text>
          <Text color={theme.text} bold>
            {limit === null ? "—" : formatUsd(limit)}
          </Text>
        </Box>
        <Box>
          <Text color={theme.muted}>Used </Text>
          <Text color={theme.text} bold>
            {usedUsd === null ? "—" : formatUsd(usedUsd)}
          </Text>
        </Box>
        <Box>
          <Text color={theme.muted}>Balance </Text>
          <Text color={theme.accent} bold>
            {balance === null ? "—" : formatUsd(balance)}
          </Text>
        </Box>
        <Box>
          <Text color={theme.muted}>Top up </Text>
          <Text color={theme.accent}>{TOPUP_URL}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.dim}>Email dan free credits tidak tersedia lewat API key.</Text>
        <Text color={theme.dim}>Lihat detail lengkap di panel: {LOGIN_URL}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>q keluar · metatech topup untuk isi saldo · metatech logout untuk keluar</Text>
      </Box>
    </Box>
  );
}
