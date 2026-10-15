// The Android app (com.hf2j.webchirp): a Trusted Web Activity, published on
// Google Play, that opens this site full-screen in Chrome. Nothing on the page
// can ask Chrome whether it is running inside one, so the app says so in the
// URL it launches: its launcher opens the site with ANDROID_APP_LAUNCH_PARAMS
// (the startUrl in the app's Bubblewrap twa-manifest.json), and the page
// remembers that for the rest of the tab's session, because a reload or a trip
// to about.html and back arrives without the query.

// The query the app's launcher opens the site with. UTM parameters, as the web
// manifest's start_url uses for home-screen installs, so analytics attributes
// the app's sessions to it without any code of its own.
export const ANDROID_APP_LAUNCH_PARAMS: Readonly<Record<string, string>> = {
  utm_source: "android_app",
  utm_medium: "twa",
};

// The sessionStorage key that carries an app launch past the first page.
const SESSION_KEY = "webchirp-android-app";

// Whether a URL's query carries every parameter the app launches the site
// with. All of them, so a link that happens to reuse one UTM value does not
// count as the app.
export function isAndroidAppLaunch(search: string): boolean {
  const params = new URLSearchParams(search);
  return Object.entries(ANDROID_APP_LAUNCH_PARAMS).every(([key, value]) => params.get(key) === value);
}

// Whether this page is running inside the Android app: launched by it now, or
// earlier in this tab's session. sessionStorage throws where site data is
// blocked; that only loses the memory, and the launch page itself still counts.
export function runsInAndroidApp(win: Window | null | undefined): boolean {
  if (isAndroidAppLaunch(win?.location?.search ?? "")) {
    try {
      win?.sessionStorage?.setItem(SESSION_KEY, "1");
    } catch {
      /* ignored */
    }
    return true;
  }
  try {
    return win?.sessionStorage?.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}
