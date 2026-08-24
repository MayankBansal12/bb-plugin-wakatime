import { createRoot } from "react-dom/client";
import "../app";
import { getCaptured } from "./sdk-mock";

const Dashboard = getCaptured();
const el = document.getElementById("root")!;
if (Dashboard) createRoot(el).render(<Dashboard subPath="" />);
else el.textContent = "no navPanel captured";
