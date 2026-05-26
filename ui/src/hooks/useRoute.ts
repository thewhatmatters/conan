import { useCallback, useEffect, useState } from "react";

export type Route = "overview" | "agents" | "skills" | "whatsnew" | "settings";

/** Map a URL pathname to one of our routes. */
function routeFor(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/agents") return "agents";
  if (p === "/skills") return "skills";
  if (p === "/whats-new") return "whatsnew";
  if (p === "/settings") return "settings";
  return "overview";
}

/** Canonical pathname for a route. */
function pathFor(route: Route): string {
  switch (route) {
    case "agents":
      return "/agents";
    case "skills":
      return "/skills";
    case "whatsnew":
      return "/whats-new";
    case "settings":
      return "/settings";
    default:
      return "/";
  }
}

/**
 * pushState-based router (US-017, extends v2 US-006) — no react-router.
 * Destinations: Overview (/), Agents (/agents), Skills (/skills), What's New
 * (/whats-new, US-030), Settings (/settings). Tracks the current route, exposes
 * a `navigate` that pushes
 * history (so back/forward work), and listens for popstate. The gateway's SPA
 * fallback serves index.html for any path, so deep-linking to any route loads
 * the app there.
 */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() =>
    routeFor(window.location.pathname),
  );

  useEffect(() => {
    const onPop = () => setRoute(routeFor(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
