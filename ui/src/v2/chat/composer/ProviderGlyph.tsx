/**
 * ProviderGlyph — a provider's brand mark for the composer's picker.
 *
 * Claude's asterisk is the artboard's own asset: the path is lifted verbatim
 * from S5-0's node UV-0 (`get_jsx`), and its colour is the BRAND token, not a
 * theme step — a provider mark must not drift with the palette. Codex and Grok
 * fall back to the registry's avatar letter, which is what v1's sidebar shows
 * for them today.
 *
 * v2's `ThreadRow` carries the same glyph. That duplication is deliberate
 * (contract §4.4): a shared primitive would put two owners on one file, and
 * the two uses differ — this one takes a size and a letter fallback from the
 * live registry, the row's is fixed at avatar size.
 */
import * as stylex from "@stylexjs/stylex";
import { Text } from "@astryxdesign/core/Text";

const styles = stylex.create({
  glyph: {
    color: "var(--conan-brand-claude)",
    flexShrink: 0,
  },
});

export interface ProviderGlyphProps {
  providerId: string;
  /** Registry avatar letter — the honest fallback for a mark we don't ship. */
  letter: string;
  size?: number;
}

const CLAUDE_PATH =
  "M2.279 21.273l6.293-3.529 0.107-0.307-0.107-0.17H8.267l-1.053-0.064-3.598-0.098-3.118-0.129-3.022-0.163-0.761-0.161L-4 15.712l0.074-0.469 0.64-0.428 0.914 0.08 2.027 0.137 3.037 0.211 2.203 0.129 3.265 0.34h0.519l0.073-0.209-0.178-0.131-0.138-0.129-3.144-2.128-3.402-2.251-1.782-1.296-0.965-0.655-0.485-0.616-0.211-1.344 0.875-0.962 1.174 0.08 0.3 0.081 1.191 0.915 2.544 1.968 3.321 2.444 0.487 0.405 0.193-0.137 0.026-0.098-0.219-0.365-1.807-3.261-1.928-3.32-0.858-1.376-0.227-0.826a3.96 3.96 0 0 1-0.139-0.972L4.378 0.179 4.928 0l1.328 0.179 0.56 0.485 0.827 1.885 1.336 2.972 2.073 4.04 0.608 1.198 0.324 1.109 0.122 0.34h0.21V12.013l0.171-2.274 0.316-2.794 0.307-3.593 0.106-1.013 0.502-1.214 0.996-0.656 0.778 0.374 0.64 0.913-0.089 0.592-0.381 2.468-0.746 3.871-0.485 2.589h0.283l0.324-0.323 1.313-1.741 2.203-2.752 0.973-1.093 1.133-1.206 0.73-0.574h1.377l1.013 1.505-0.453 1.555-1.419 1.796-1.174 1.522-1.686 2.267-1.053 1.813 0.097 0.147 0.251-0.027 3.808-0.808 2.057-0.373 2.455-0.42 1.111 0.517 0.121 0.527-0.437 1.076-2.626 0.648-3.078 0.616-4.586 1.084-0.056 0.04 0.066 0.081 2.065 0.195 0.883 0.048h2.162l4.027 0.3 1.053 0.696 0.632 0.851-0.105 0.646-1.62 0.827-2.187-0.519-5.105-1.213-1.749-0.439h-0.243v0.147l1.457 1.424 2.675 2.413 3.345 3.107 0.17 0.771-0.43 0.606-0.453-0.065-2.94-2.209-1.135-0.996-2.568-2.16h-0.17v0.226l0.592 0.866 3.126 4.694 0.163 1.44-0.227 0.471-0.81 0.284-0.891-0.163-1.832-2.566-1.887-2.89-1.524-2.59-0.186 0.106-0.899 9.672-0.421 0.494-0.972 0.373-0.81-0.615-0.429-0.996 0.429-1.968 0.519-2.565 0.42-2.04 0.381-2.533 0.227-0.843-0.016-0.056-0.187 0.024-1.912 2.623-2.906 3.926-2.302 2.46-0.552 0.219-0.956-0.493 0.09-0.883 0.534-0.785 3.184-4.048 1.92-2.51 1.24-1.448-0.008-0.21h-0.073L1.51 24.747l-1.507 0.194-0.649-0.608 0.081-0.994 0.308-0.324 2.544-1.75-0.008 0.008z";

export default function ProviderGlyph({
  providerId,
  letter,
  size = 16,
}: ProviderGlyphProps) {
  if (providerId !== "claude") {
    return (
      <Text type="supporting" weight="semibold" color="primary">
        {letter}
      </Text>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="-4 0 32 32"
      aria-hidden
      {...stylex.props(styles.glyph)}
    >
      <path fill="currentColor" fillRule="nonzero" d={CLAUDE_PATH} />
    </svg>
  );
}
