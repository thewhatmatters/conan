import { useCallback, useEffect, useState } from "react";

export type Route = "overview" | "settings";

/** Map a URL pathname to one of our two routes. */
function routeFor(pathname: string): Route {
  return pathname.replace(/\/+$/, "") === "/settings" ? "settings" : "overview";
}

/** Canonical pathname for a route. */
function pathFor(route: Route): string {
  return route === "settings" ? "/settings" : "/";
}

/**
 * pushState-based router (US-006) — no react-router. Tracks the current route,
 * exposes a `navigate` that pushes history (so back/forward work), and listens
 * for popstate. The gateway's SPA fallback serves index.html for any path, so
 * deep-linking to /settings loads the app on that route.
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
