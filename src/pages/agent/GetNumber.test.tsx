import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---- Mocks ----------------------------------------------------------------

// useAuth: minimal shape consumed by GetNumber
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { per_request_limit: 15, daily_limit: 100 },
    maintenanceMode: false,
    maintenanceMessage: "",
  }),
}));

// toast: capture all calls so we can assert UI feedback without a real DOM toast
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (args: unknown) => toastSpy(args),
}));

// api: stub every call GetNumber makes. Mutable refs so individual tests
// can change behaviour mid-flight (simulating an admin toggle).
const apiState = {
  providersResponse: [
    { id: "acchub", name: "AccHub" },
    { id: "msi", name: "MSI SMS" },
  ] as { id: string; name: string }[],
  getNumberImpl: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      providers: vi.fn(() => Promise.resolve({ providers: apiState.providersResponse })),
      numbersConfig: vi.fn(() => Promise.resolve({ otp_expiry_sec: 480, server_now: Math.floor(Date.now() / 1000) })),
      countries: vi.fn(() => Promise.resolve({ countries: [{ id: 1, name: "Bangladesh", code: "+880" }] })),
      operators: vi.fn(() => Promise.resolve({ operators: [{ id: 10, name: "Grameen", price_bdt: 5 }] })),
      msiRanges: vi.fn(() => Promise.resolve({ ranges: [{ name: "Peru-Bitel", count: 42 }] })),
      imsRanges: vi.fn(() => Promise.resolve({ ranges: [] })),
      myNumbers: vi.fn(() => Promise.resolve({ numbers: [] })),
      getNumber: vi.fn((args: unknown) => apiState.getNumberImpl(args)),
      syncOtp: vi.fn(() => Promise.resolve({ updated: 0 })),
      releaseNumber: vi.fn(() => Promise.resolve({ ok: true })),
    },
  };
});

// Import AFTER mocks so the component picks up the stubbed modules.
// eslint-disable-next-line import/first
import AgentGetNumber from "./GetNumber";
// eslint-disable-next-line import/first
import { ApiError } from "@/lib/api";

// ---- Helpers --------------------------------------------------------------

beforeEach(() => {
  toastSpy.mockReset();
  apiState.providersResponse = [
    { id: "acchub", name: "AccHub" },
    { id: "msi", name: "MSI SMS" },
  ];
  apiState.getNumberImpl = vi.fn(() => Promise.resolve({ allocated: [], errors: [] }));
  // jsdom: clipboard + Notification stubs
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  (global as unknown as { Notification: undefined }).Notification = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- Tests ----------------------------------------------------------------

describe("AgentGetNumber — provider toggle awareness", () => {
  it("renders only the providers returned by /numbers/providers", async () => {
    render(<AgentGetNumber />);
    // Server A (acchub) + Server C (msi) both enabled → both visible.
    expect(await screen.findByRole("button", { name: "Server A" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Server C" })).toBeInTheDocument();
    // Server B (ims) not enabled → must NOT render.
    expect(screen.queryByRole("button", { name: "Server B" })).not.toBeInTheDocument();
  });

  it("hides a server's button after admin disables it (refresh on tab focus)", async () => {
    render(<AgentGetNumber />);
    expect(await screen.findByRole("button", { name: "Server C" })).toBeInTheDocument();

    // Admin toggles MSI off in another tab.
    apiState.providersResponse = [{ id: "acchub", name: "AccHub" }];

    // Simulate the user returning to the GetNumber tab.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Server C" })).not.toBeInTheDocument();
    });
    // Server A is still there, and is the auto-fallback selection.
    expect(screen.getByRole("button", { name: "Server A" })).toBeInTheDocument();
  });

  it("on PROVIDER_DISABLED 403, refreshes list, auto-switches, and toasts a friendly message", async () => {
    const user = userEvent.setup();
    render(<AgentGetNumber />);

    // Pick Server C (MSI) and a range so the Get button is enabled.
    await user.click(await screen.findByRole("button", { name: "Server C" }));
    await user.click(await screen.findByRole("button", { name: /select a range/i }));
    await user.click(await screen.findByText("Peru-Bitel"));

    // Backend now rejects: provider was just disabled by admin.
    apiState.getNumberImpl = vi.fn(() =>
      Promise.reject(
        new ApiError("MSI SMS is currently disabled by admin. Please pick another source.", 403, {
          code: "PROVIDER_DISABLED",
          provider: "msi",
        }),
      ),
    );
    // And the providers list will reflect the toggle on the next refresh.
    apiState.providersResponse = [{ id: "acchub", name: "AccHub" }];

    // Click Get Number.
    await user.click(screen.getByRole("button", { name: /get number/i }));

    // Pre-flight refresh ALSO sees the new state, so we expect a clear toast
    // about the source being disabled and an auto-switch to Server A.
    await waitFor(() => {
      const titles = toastSpy.mock.calls.map((c) => (c[0] as { title?: string })?.title);
      const matched = titles.some((t) =>
        t === "Source disabled by admin" || t === "Provider disabled mid-session",
      );
      expect(matched).toBe(true);
    });

    // Server C must be gone; Server A remains as the active choice.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Server C" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Server A" })).toBeInTheDocument();
  });
});