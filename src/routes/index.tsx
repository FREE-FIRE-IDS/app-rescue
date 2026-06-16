import { createFileRoute } from "@tanstack/react-router";
import MRBinaryApp from "@/components/MRBinaryApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "M-R BINARY | GOLD" },
      {
        name: "description",
        content:
          "M-R BINARY — futuristic market signal dashboard with live Yahoo Finance feed and real-time technical indicator analysis for XAU/USD and major pairs.",
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
  return <MRBinaryApp />;
}
