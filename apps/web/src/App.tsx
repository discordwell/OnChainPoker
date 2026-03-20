import { useGameState } from "./hooks/useGameState";
import { GameView } from "./components/GameView";
import { AdminView } from "./components/AdminView";

export function App() {
  const g = useGameState();

  if (g.viewMode === "game") {
    return <GameView g={g} />;
  }

  return <AdminView g={g} />;
}
