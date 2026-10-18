import { createElement } from "react";
import { expect } from "chai";
import sinon from "sinon";
import fetchMock from "fetch-mock";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  centeredPopupFeatures,
  connectWithPopup,
  OAUTH_CHANNEL,
  OAUTH_STORAGE_KEY,
  OAuthOutcome,
  stopBackgroundWatches,
} from "../../../../frontend/js/features/ai-assist/connectors/oauth-popup";
import { CONNECTORS_CHANGED_EVENT } from "../../../../frontend/js/features/ai-assist/connectors/api";
import ConnectorsWidget from "../../../../frontend/js/features/ai-assist/components/connectors/connectors-widget";
import { ConnectorView } from "../../../../frontend/js/features/ai-assist/connectors/types";

const ORIGIN = window.location.origin;
const CONNECTOR_ID = "conn-1";
const AUTHORIZE_URL = `/ai-assist/connectors/${CONNECTOR_ID}/authorize`;
const AUTH_HREF = "https://auth.example.com/authorize?client_id=abc";
const LIST_META = {
  redirectUri:
    "https://overleaf.example.com/ai-assist/connectors/oauth/callback",
  clientMetadataUrl: null,
};

type FakePopup = {
  closed: boolean;
  close: sinon.SinonSpy;
  location: { href: string };
  opener: unknown;
};

function makePopup(): FakePopup {
  const popup: FakePopup = {
    closed: false,
    close: sinon.spy(() => {
      popup.closed = true;
    }),
    location: { href: "" },
    // What window.open hands the new window: a handle back to this page
    opener: window,
  };
  return popup;
}

function setMeta() {
  window.metaAttributesCache?.clear();
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">';
}

/** Overrides window/screen geometry for one test; restored by `restoreGeometry`. */
const geometryRestore: Array<() => void> = [];
function setProp(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => value,
  });
  geometryRestore.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}
function restoreGeometry() {
  while (geometryRestore.length) geometryRestore.pop()?.();
}

function setGeometry({
  screenX = 0,
  screenY = 0,
  outerWidth = 1280,
  outerHeight = 800,
  availWidth = 1920,
  availHeight = 1080,
}: {
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
  availWidth?: number;
  availHeight?: number;
} = {}) {
  setProp(window, "screenX", screenX);
  setProp(window, "screenY", screenY);
  setProp(window, "outerWidth", outerWidth);
  setProp(window, "outerHeight", outerHeight);
  setProp(window.screen, "availWidth", availWidth);
  setProp(window.screen, "availHeight", availHeight);
}

function connectorView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: CONNECTOR_ID,
    name: "Docs",
    url: "https://docs.example.com/mcp",
    transport: "auto",
    authMode: "auto",
    enabled: true,
    status: "needs_auth",
    lastError: null,
    timeoutSeconds: null,
    preset: null,
    defaultPermission: "ask",
    headers: [],
    oauth: {
      clientMode: "auto",
      clientId: null,
      hasClientSecret: false,
      scopes: "",
      authorizationUrl: "",
      tokenUrl: "",
      tokenEndpointAuthMethod: "auto",
      extraParams: [],
      issuer: null,
      registration: null,
      grantedScopes: null,
      expiresAt: null,
      hasRefreshToken: false,
    },
    server: null,
    tools: [],
    toolsUpdatedAt: null,
    createdAt: "2026-10-15T10:00:00Z",
    updatedAt: "2026-10-15T10:00:00Z",
    lastConnectedAt: null,
    ...overrides,
  } as ConnectorView;
}

/** Mutable list state the mocked GET /ai-assist/connectors reads from. */
let listStatus: ConnectorView["status"] = "needs_auth";
function mockList() {
  fetchMock.get("/ai-assist/connectors", () => ({
    connectors: [connectorView({ status: listStatus })],
    meta: LIST_META,
  }));
}

function listCalls() {
  return fetchMock.callHistory.calls("/ai-assist/connectors");
}

function postMessageEvent(data: unknown, origin = ORIGIN) {
  window.dispatchEvent(new window.MessageEvent("message", { data, origin }));
}

function storageEvent(key: string, value: unknown) {
  window.dispatchEvent(
    new window.StorageEvent("storage", {
      key,
      newValue: typeof value === "string" ? value : JSON.stringify(value),
    }),
  );
}

function oauthMessage(
  overrides: Partial<{
    connectorId: string;
    status: "connected" | "error";
    error?: string;
  }> = {},
) {
  return {
    type: "ai-assist:connector-oauth",
    connectorId: CONNECTOR_ID,
    status: "connected",
    ...overrides,
  };
}

// sinon 7 has no tickAsync, so the clock is stepped manually. Only timeout
// functions are faked; setImmediate stays real and flushes pending promise
// callbacks (fetch responses) between steps.
const realSetImmediate = global.setImmediate;
function settle() {
  return new Promise<void>((resolve) => realSetImmediate(() => resolve()));
}

async function advance(clock: sinon.SinonFakeTimers, ms: number) {
  const step = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.tick(Math.min(step, ms - elapsed));
    await settle();
  }
  // Reading a response body takes several turns of the event loop
  for (let i = 0; i < 10; i++) await settle();
}

function flush(clock: sinon.SinonFakeTimers) {
  return advance(clock, 10);
}

function useFakeTimeouts() {
  return sinon.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
}

/**
 * The test bootstrap stubs BroadcastChannel as a no-op. This in-memory
 * version delivers to every other open channel with the same name.
 */
class FakeBroadcastChannel {
  static open: FakeBroadcastChannel[] = [];
  name: string;
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.open.push(this);
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.open) {
      if (other === this || other.closed || other.name !== this.name) continue;
      Promise.resolve().then(() => other.onmessage?.({ data }));
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.open = FakeBroadcastChannel.open.filter(
      (c) => c !== this,
    );
  }
}

function installFakeBroadcastChannel() {
  const originals = [
    globalThis.BroadcastChannel,
    window.BroadcastChannel,
  ] as const;
  const fake = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  globalThis.BroadcastChannel = fake;
  window.BroadcastChannel = fake;
  return () => {
    globalThis.BroadcastChannel = originals[0];
    window.BroadcastChannel = originals[1];
    FakeBroadcastChannel.open = [];
  };
}

function trackOutcome(promise: Promise<OAuthOutcome>) {
  const state: { outcome?: OAuthOutcome } = {};
  promise.then((outcome) => {
    state.outcome = outcome;
  });
  return state;
}

describe("oauth-popup", function () {
  let clock: sinon.SinonFakeTimers;
  let popup: FakePopup;
  let openStub: sinon.SinonStub;
  let restoreChannel: () => void;

  beforeEach(function () {
    setMeta();
    restoreChannel = installFakeBroadcastChannel();
    fetchMock.removeRoutes().clearHistory();
    listStatus = "needs_auth";
    clock = useFakeTimeouts();
    popup = makePopup();
    openStub = sinon.stub(window, "open").returns(popup as unknown as Window);
    fetchMock.post(AUTHORIZE_URL, { authorizationUrl: AUTH_HREF });
    mockList();
  });

  afterEach(function () {
    stopBackgroundWatches();
    clock.restore();
    openStub.restore();
    restoreChannel();
    restoreGeometry();
    fetchMock.removeRoutes().clearHistory();
  });

  describe("centeredPopupFeatures", function () {
    it("centres the popup on the browser window", function () {
      setGeometry({
        screenX: 100,
        screenY: 50,
        outerWidth: 1400,
        outerHeight: 900,
        availWidth: 1920,
        availHeight: 1080,
      });
      // left = 100 + (1400 - 520) / 2, top = 50 + (900 - 720) / 2
      expect(centeredPopupFeatures()).to.equal(
        "popup,width=520,height=720,left=540,top=140",
      );
    });

    it("uses the requested size when it fits on screen", function () {
      setGeometry({ outerWidth: 1000, outerHeight: 800 });
      expect(centeredPopupFeatures(300, 200)).to.equal(
        "popup,width=300,height=200,left=350,top=300",
      );
    });

    it("clamps the popup size to screen.availWidth and availHeight", function () {
      setGeometry({
        screenX: 0,
        screenY: 0,
        outerWidth: 1000,
        outerHeight: 800,
        availWidth: 400,
        availHeight: 300,
      });
      // width/height shrink to the screen; the centred spot would overflow
      // the screen, so it is clamped to the screen's top-left corner
      expect(centeredPopupFeatures()).to.equal(
        "popup,width=400,height=300,left=0,top=0",
      );
    });

    it("never produces a negative left or top", function () {
      setGeometry({
        screenX: -1000,
        screenY: -1000,
        outerWidth: 200,
        outerHeight: 200,
      });
      expect(centeredPopupFeatures()).to.equal(
        "popup,width=520,height=720,left=0,top=0",
      );
    });

    it("never produces a negative left or top when the window is small", function () {
      setGeometry({
        screenX: 0,
        screenY: 0,
        outerWidth: 100,
        outerHeight: 100,
      });
      const features = centeredPopupFeatures();
      expect(features).to.match(/left=0,top=0$/);
      expect(features).not.to.match(/-\d/);
    });

    it("keeps the popup inside the right edge of the screen", function () {
      // Window half off the right edge: the centred spot would overflow
      setGeometry({
        screenX: 1800,
        screenY: 0,
        outerWidth: 400,
        outerHeight: 800,
        availWidth: 1920,
        availHeight: 1080,
      });
      setProp(window.screen, "availLeft", 0);
      setProp(window.screen, "availTop", 0);
      // desired left = 1800 + (400 - 520) / 2 = 1740, clamped to 1920 - 520
      expect(centeredPopupFeatures()).to.equal(
        "popup,width=520,height=720,left=1400,top=40",
      );
    });

    it("keeps the popup inside a screen that sits left of the primary one", function () {
      setGeometry({
        screenX: -1900,
        screenY: 0,
        outerWidth: 300,
        outerHeight: 800,
        availWidth: 1920,
        availHeight: 1080,
      });
      setProp(window.screen, "availLeft", -1920);
      setProp(window.screen, "availTop", 0);
      // desired left = -2010, clamped to availLeft
      expect(centeredPopupFeatures()).to.equal(
        "popup,width=520,height=720,left=-1920,top=40",
      );
    });
  });

  describe("window.open", function () {
    it("opens the popup synchronously with the centred features", function () {
      setGeometry({ outerWidth: 1400, outerHeight: 900 });
      const expected = centeredPopupFeatures();
      let authorizeCallsWhenOpened: number | null = null;
      openStub.callsFake(() => {
        authorizeCallsWhenOpened =
          fetchMock.callHistory.calls(AUTHORIZE_URL).length;
        return popup as unknown as Window;
      });

      connectWithPopup(CONNECTOR_ID);

      expect(openStub).to.have.been.calledOnce;
      expect(openStub).to.have.been.calledWith(
        "",
        `ai-assist-connector-${CONNECTOR_ID}`,
        expected,
      );
      // Opened before the authorize request, so popup blockers accept it
      expect(authorizeCallsWhenOpened).to.equal(0);
    });

    it("clears the popup's opener, so the sign-in site cannot navigate this page", function () {
      connectWithPopup(CONNECTOR_ID);

      expect(popup.opener).to.equal(null);
    });
  });

  describe("callback messages", function () {
    it("resolves connected on a matching window message", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      postMessageEvent(oauthMessage());
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({ status: "connected" });
    });

    it("resolves connected on a matching storage message", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      storageEvent(OAUTH_STORAGE_KEY, oauthMessage());
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({ status: "connected" });
    });

    it("ignores messages for other connector ids", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      postMessageEvent(oauthMessage({ connectorId: "conn-other" }));
      storageEvent(
        OAUTH_STORAGE_KEY,
        oauthMessage({
          connectorId: "conn-other",
          status: "error",
          error: "x",
        }),
      );
      await flush(clock);

      expect(outcome.outcome).to.equal(undefined);
    });

    it("ignores window messages from another origin", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      postMessageEvent(oauthMessage(), "https://evil.example.com");
      await flush(clock);

      expect(outcome.outcome).to.equal(undefined);

      postMessageEvent(oauthMessage());
      await flush(clock);
      expect(outcome.outcome).to.deep.equal({ status: "connected" });
    });

    it("ignores storage events for other keys and malformed values", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      storageEvent("some-other-key", oauthMessage());
      storageEvent(OAUTH_STORAGE_KEY, "{not json");
      await flush(clock);

      expect(outcome.outcome).to.equal(undefined);
    });

    it("resolves with the callback error when the callback reports a failure", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      postMessageEvent(
        oauthMessage({ status: "error", error: "access_denied" }),
      );
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({
        status: "error",
        error: "access_denied",
      });
      expect(popup.close).to.have.been.calledOnce;
    });
  });

  describe("authorize request", function () {
    it("resolves error with the server message and closes the popup", async function () {
      fetchMock.removeRoutes();
      fetchMock.post(AUTHORIZE_URL, {
        status: 500,
        body: { error: "Discovery failed" },
      });
      mockList();
      mockList();

      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({
        status: "error",
        error: "Discovery failed",
      });
      expect(popup.close).to.have.been.calledOnce;
      // no polling or closed-window checks after failure
      expect(listCalls()).to.have.length(0);
    });

    it("uses a generic message when the authorize error has no body", async function () {
      fetchMock.removeRoutes();
      fetchMock.post(AUTHORIZE_URL, { status: 500, body: "" });
      mockList();

      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(outcome.outcome?.status).to.equal("error");
      expect(popup.close).to.have.been.calledOnce;
    });

    it("navigates the popup to the authorization URL", async function () {
      trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(popup.location.href).to.equal(AUTH_HREF);
    });

    it("rejects an invalid authorization URL with an error and closes the popup", async function () {
      fetchMock.removeRoutes();
      fetchMock.post(AUTHORIZE_URL, {
        authorizationUrl: "javascript:alert(1)",
      });
      mockList();

      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({
        status: "error",
        error: "The MCP server returned an invalid authorization URL",
      });
      expect(popup.location.href).to.equal("");
      expect(popup.close).to.have.been.calledOnce;
    });

    it("rejects a non-URL authorization value", async function () {
      fetchMock.removeRoutes();
      fetchMock.post(AUTHORIZE_URL, { authorizationUrl: "not a url" });
      mockList();

      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(outcome.outcome?.status).to.equal("error");
      expect(popup.location.href).to.equal("");
    });

    it("resolves an error instead of navigating when the popup is blocked", async function () {
      openStub.returns(null);

      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({
        status: "error",
        error:
          "The sign-in window was blocked. Allow pop-ups for this site and click Sign in again.",
      });
      // No polling, timers or same-tab navigation are left behind
      await advance(clock, 10000);
      expect(listCalls()).to.have.length(0);
    });

    it("resolves cancelled and does not navigate when the window was closed during the authorize request", async function () {
      fetchMock.removeRoutes();
      fetchMock.post(AUTHORIZE_URL, { authorizationUrl: AUTH_HREF });
      mockList();
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      popup.closed = true;
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
      expect(popup.location.href).to.equal("");
    });

    it("resolves cancelled when the signal is aborted", async function () {
      const controller = new AbortController();
      const outcome = trackOutcome(
        connectWithPopup(CONNECTOR_ID, { signal: controller.signal }),
      );
      await flush(clock);

      controller.abort();
      await flush(clock);

      expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
      expect(popup.close).to.have.been.calledOnce;
    });
  });

  describe("popup closed", function () {
    it("resolves cancelled after the grace when the list says not connected", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      popup.closed = true;
      // Closed is noticed within 500ms, then 1500ms of grace before the last look
      await advance(clock, 1000);
      expect(outcome.outcome).to.equal(undefined);

      await advance(clock, 1500);
      expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
      // Already closed: nothing to close again
      expect(popup.close).not.to.have.been.called;
    });

    it("resolves connected when the list says connected after the window closed", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      popup.closed = true;
      // The sign-in finished as the window closed; the last look sees it
      listStatus = "connected";
      await advance(clock, 2100);

      expect(outcome.outcome).to.deep.equal({ status: "connected" });
    });

    it("does not start the grace check while the popup is still open", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      await advance(clock, 5000);

      expect(outcome.outcome).to.equal(undefined);
      expect(popup.close).not.to.have.been.called;
    });
  });

  describe("background watch after the window looked closed", function () {
    it("notifies the connector views when the sign-in completes later", async function () {
      const notified = sinon.spy();
      window.addEventListener(CONNECTORS_CHANGED_EVENT, notified);
      try {
        const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
        await flush(clock);

        // COOP: the window reads closed while the sign-in is still running
        popup.closed = true;
        await advance(clock, 2100);
        expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
        expect(notified).not.to.have.been.called;

        listStatus = "connected";
        await advance(clock, 5000);
        expect(notified).to.have.been.calledOnce;
      } finally {
        window.removeEventListener(CONNECTORS_CHANGED_EVENT, notified);
        stopBackgroundWatches();
      }
    });

    it("stops watching once the sign-in is seen", async function () {
      const notified = sinon.spy();
      window.addEventListener(CONNECTORS_CHANGED_EVENT, notified);
      try {
        trackOutcome(connectWithPopup(CONNECTOR_ID));
        await flush(clock);
        popup.closed = true;
        await advance(clock, 2100);

        listStatus = "connected";
        await advance(clock, 5000);
        const callsAfterConnect = listCalls().length;
        await advance(clock, 20000);

        expect(listCalls().length).to.equal(callsAfterConnect);
        expect(notified).to.have.been.calledOnce;
      } finally {
        window.removeEventListener(CONNECTORS_CHANGED_EVENT, notified);
        stopBackgroundWatches();
      }
    });

    it("gives up at the ten minute mark and stops polling", async function () {
      trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);
      popup.closed = true;
      await advance(clock, 2100);

      await advance(clock, 10 * 60 * 1000);
      const callsAtGiveUp = listCalls().length;
      await advance(clock, 60000);

      expect(listCalls().length).to.equal(callsAtGiveUp);
    });

    it("is replaced by a new attempt for the same connector", async function () {
      trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);
      popup.closed = true;
      await advance(clock, 2100);

      // A new attempt: the earlier background watch must not keep polling
      popup = makePopup();
      openStub.returns(popup as unknown as Window);
      trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);
      const before = listCalls().length;
      await advance(clock, 5000);
      // Only the new attempt's status poll (every 2s) is running
      expect(listCalls().length - before).to.be.at.most(3);
      stopBackgroundWatches();
    });
  });

  describe("polling and give-up", function () {
    it("resolves connected when the list reports the connector as connected", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      listStatus = "connected";
      await advance(clock, 2000);

      expect(outcome.outcome).to.deep.equal({ status: "connected" });
    });

    it("gives up after ten minutes and closes the still-open popup", async function () {
      const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));
      await flush(clock);

      await advance(clock, 10 * 60 * 1000 - 100);
      expect(outcome.outcome).to.equal(undefined);

      await advance(clock, 200);
      expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
      expect(popup.close).to.have.been.calledOnce;
    });
  });
});

describe("oauth-popup BroadcastChannel", function () {
  let openStub: sinon.SinonStub;
  let restoreChannel: () => void;

  beforeEach(function () {
    setMeta();
    restoreChannel = installFakeBroadcastChannel();
    fetchMock.removeRoutes().clearHistory();
    openStub = sinon
      .stub(window, "open")
      .returns(makePopup() as unknown as Window);
    fetchMock.post(AUTHORIZE_URL, { authorizationUrl: AUTH_HREF });
    mockList();
  });

  afterEach(function () {
    openStub.restore();
    restoreChannel();
    fetchMock.removeRoutes().clearHistory();
  });

  it("resolves connected from a BroadcastChannel message", async function () {
    const outcome = trackOutcome(connectWithPopup(CONNECTOR_ID));

    const sender = new BroadcastChannel(OAUTH_CHANNEL);
    try {
      sender.postMessage(oauthMessage());
      await waitFor(() => {
        expect(outcome.outcome).to.deep.equal({ status: "connected" });
      });
    } finally {
      sender.close();
    }
  });

  it("ignores BroadcastChannel messages for other connectors", async function () {
    const controller = new AbortController();
    const outcome = trackOutcome(
      connectWithPopup(CONNECTOR_ID, { signal: controller.signal }),
    );

    const sender = new BroadcastChannel(OAUTH_CHANNEL);
    try {
      sender.postMessage(oauthMessage({ connectorId: "conn-other" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(outcome.outcome).to.equal(undefined);
    } finally {
      sender.close();
      // Ends the pending connection so its channel and timers are released
      controller.abort();
    }
    await waitFor(() => {
      expect(outcome.outcome).to.deep.equal({ status: "cancelled" });
    });
  });
});

describe("ConnectorsWidget OAuth refresh", function () {
  let restoreChannel: () => void;

  beforeEach(function () {
    setMeta();
    restoreChannel = installFakeBroadcastChannel();
    fetchMock.removeRoutes().clearHistory();
    listStatus = "needs_auth";
    mockList();
  });

  afterEach(function () {
    restoreChannel();
    fetchMock.removeRoutes().clearHistory();
  });

  it("refetches the list when a storage event for the OAuth key arrives", async function () {
    render(createElement(ConnectorsWidget));
    await screen.findByText("Docs");
    const before = listCalls().length;

    listStatus = "connected";
    act(() => {
      storageEvent(OAUTH_STORAGE_KEY, oauthMessage());
    });

    await waitFor(() => {
      expect(listCalls().length).to.equal(before + 1);
    });
  });

  it("ignores storage events for other keys", async function () {
    render(createElement(ConnectorsWidget));
    await screen.findByText("Docs");
    const before = listCalls().length;

    act(() => {
      storageEvent("some-other-key", oauthMessage());
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listCalls().length).to.equal(before);
  });

  it("refetches the list when an OAuth message arrives on the BroadcastChannel", async function () {
    render(createElement(ConnectorsWidget));
    await screen.findByText("Docs");
    const before = listCalls().length;

    const sender = new BroadcastChannel(OAUTH_CHANNEL);
    try {
      sender.postMessage(oauthMessage());
      await waitFor(() => {
        expect(listCalls().length).to.equal(before + 1);
      });
    } finally {
      sender.close();
    }
  });
});
