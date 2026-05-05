// Wave 4 — companion webview entry。
// companion.html 加载 → ReactDOM 挂这棵树。

import React from "react";
import ReactDOM from "react-dom/client";
import CompanionApp from "./companion/CompanionApp";
import "./styles.css";
import "./companion/companion.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CompanionApp />
  </React.StrictMode>,
);
