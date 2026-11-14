async function loadMobileApp() {
  const bundle = await fetch("./dist/app.js", { method: "HEAD", cache: "no-store" });
  if (bundle.ok) {
    await import("./dist/app.js");
    return;
  }
  if (bundle.status === 404) {
    await import("./app.js");
    return;
  }
  throw new Error(`Mobile bundle check failed with HTTP ${bundle.status}`);
}

loadMobileApp().catch((error) => {
  console.error("Could not start the mobile app", error);
});
