/**
 * WHA-226 — Overview decision headline + Needs you / Running / Blocked tiles.
 *
 * Counts come from `overviewTiles()` (a `sectionFor` recount). No Median gate
 * wait, no Shipped 24h, no Refresh/timestamp — those live in WHA-231's toolbar
 * or stay dropped until timestamps exist.
 */
import * as stylex from "@stylexjs/stylex";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import { overviewTiles, type OverviewTile } from "../lib/saganOverviewTiles.ts";

const styles = stylex.create({
  root: {
    alignItems: "stretch",
    gap: "var(--conan-space-4)",
    width: "100%",
  },
  headline: {
    margin: 0,
  },
  tileGrid: {
    width: "100%",
  },
  tile: {
    alignItems: "flex-start",
    gap: "var(--conan-space-1)",
    minWidth: 0,
    width: "100%",
  },
  tileCount: {
    margin: 0,
  },
});

function OverviewTileCard({ tile }: { tile: OverviewTile }) {
  const isZero = tile.count === 0;
  return (
    <Card
      padding={3}
      variant={isZero ? "muted" : "default"}
      data-slot="sagan-overview-tile"
      data-tile={tile.id}
      data-count={tile.count}
      aria-label={`${tile.label}: ${tile.count}${tile.detail ? `, ${tile.detail}` : ""}`}
    >
      <VStack gap={1} xstyle={styles.tile}>
        <Heading
          level={3}
          type="display-3"
          color={isZero ? "secondary" : "primary"}
          xstyle={styles.tileCount}
          data-slot="sagan-tile-count"
        >
          {tile.count}
        </Heading>
        <Text weight="semibold" color="secondary" data-slot="sagan-tile-label">
          {tile.label}
        </Text>
        {tile.detail != null ? (
          <Text type="supporting" color="secondary" data-slot="sagan-tile-detail">
            {tile.detail}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}

export function SaganOverviewHeader({ runs }: { runs: readonly SaganRunSummary[] }) {
  const { tiles, headline, decisionCount } = overviewTiles(runs);
  const calm = decisionCount <= 0;

  return (
    <VStack
      gap={4}
      xstyle={styles.root}
      data-slot="sagan-overview-header"
      data-decision-count={decisionCount}
    >
      <Heading
        level={2}
        color={calm ? "secondary" : "primary"}
        xstyle={styles.headline}
        data-slot="sagan-overview-headline"
      >
        {headline}
      </Heading>
      <Grid
        columns={{ minWidth: 140, max: 3, repeat: "fit" }}
        gap={3}
        xstyle={styles.tileGrid}
        data-slot="sagan-overview-tiles"
      >
        {tiles.map((tile) => (
          <OverviewTileCard key={tile.id} tile={tile} />
        ))}
      </Grid>
    </VStack>
  );
}
