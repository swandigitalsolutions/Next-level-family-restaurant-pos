/* Login page logic */

(async function initLogin() {
  // If already logged in, skip straight to dashboard
  try {
    await apiFetch("/me");
    window.location.href = "dashboard.html";
    return;
  } catch (e) {
    // not logged in - stay on this page
  }
})();

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById("loginError");
  const btn = document.getElementById("loginBtn");
  errorBox.textContent = "";

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    errorBox.textContent = "Please enter both username and password.";
    return;
  }

  const btnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    await apiFetch("/login", { method: "POST", body: { username, password } });
    window.location.href = "dashboard.html";
  } catch (err) {
    errorBox.textContent = err.message || "Login failed. Please try again.";
    btn.disabled = false;
    btn.innerHTML = btnHtml;
  }
});
