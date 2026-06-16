import { createFileRoute } from "@tanstack/react-router";
import MRBinaryApp from "@/components/MRBinaryApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "M-R BINARY — Educational Demo" },
      {
        name: "description",
        content:
          "Educational UI demo of a futuristic market signaling dashboard. All data is simulated — not financial advice.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <>
      <div
        role="alert"
        className="fixed top-0 inset-x-0 z-[100] bg-yellow-500 text-black text-center text-xs sm:text-sm font-bold px-3 py-1.5 shadow-lg"
      >
        ⚠ EDUCATIONAL DEMO — ALL DATA IS SIMULATED. NOT FINANCIAL ADVICE. DO NOT TRADE REAL MONEY ON THESE SIGNALS.
      </div>
      <div className="pt-7">
        <MRBinaryApp />
      </div>
    </>
  );
}
