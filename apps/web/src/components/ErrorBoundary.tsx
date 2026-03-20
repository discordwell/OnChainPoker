import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "#0a0e14",
          color: "#c8cdd4",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
        }}>
          <h1 style={{ color: "#e5c07b", marginBottom: "1rem" }}>Something went wrong</h1>
          <p style={{ maxWidth: 500, textAlign: "center", marginBottom: "1.5rem", color: "#8b95a5" }}>
            The app encountered an unexpected error. Try refreshing the page.
          </p>
          <pre style={{
            background: "#151a22",
            padding: "1rem",
            borderRadius: 8,
            maxWidth: 600,
            overflow: "auto",
            fontSize: "0.8rem",
            color: "#e06c75",
          }}>
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              padding: "0.6rem 1.5rem",
              background: "#2ecc71",
              color: "#0a0e14",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
