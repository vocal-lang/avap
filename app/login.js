import { app } from "./firebaseInit.js";
import {
  browserSessionPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signOut,
  signInWithEmailAndPassword,
} from "firebase/auth";
const auth = getAuth(app);
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const statusMessage = document.getElementById("login-status");
const isAdminPage = document.body.classList.contains("admin-page");
const isLoginPage = Boolean(loginForm);
const logoutButton = document.getElementById("logout-button");
const sessionPersistenceReady = setPersistence(auth, browserSessionPersistence).catch((error) => {
  console.warn("Unable to set auth persistence:", error);
});



function currentPageName() {
  return window.location.pathname.split("/").pop() || "";
}

function setLoginStatus(statusElement, message, isError = false) {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.setAttribute("role", isError ? "alert" : "status");
  statusElement.setAttribute("aria-live", isError ? "assertive" : "polite");
  statusElement.style.color = isError ? "#b00020" : "#0a7a28";
}

function getFriendlyErrorMessage(error) {
  const code = error?.code || "";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/invalid-credential") return "Incorrect email or password.";
  if (code === "auth/too-many-requests") return "Too many attempts. Please try again later.";
  return "Login failed. Check your email and password.";
}

/**
 * Simple Firebase email/password login.
 * Returns the signed-in user on success and throws on failure.
 */
export async function loginWithFirebase(email, password) {
  const trimmedEmail = (email || "").trim();
  const safePassword = password || "";

  if (!trimmedEmail || !safePassword) {
    throw new Error("Email and password are required.");
  }

  // Ensure auth stays session-scoped on shared devices.
  await sessionPersistenceReady;
  const credential = await signInWithEmailAndPassword(auth, trimmedEmail, safePassword);
  return credential.user;
}

async function initializeAuthGate() {
  await sessionPersistenceReady;

  onAuthStateChanged(auth, async (user) => {
    if (isAdminPage) {
      if (!user) {
        if (currentPageName() !== "login.html") {
          window.location.replace("./login.html");
        }
        return;
      }

      // Reveal admin UI as soon as the user is authenticated; claims lookup is best-effort.
      document.body.classList.remove("auth-pending");
      try {
        const tokenResult = await user.getIdTokenResult();
        if (tokenResult.claims.masterAdmin) {
          const btn = document.getElementById("manageAccountsButton");
          if (btn) btn.style.display = "";
        }
      } catch (error) {
        console.warn("Unable to read admin claims:", error);
      }
      return;
    }

    if (isLoginPage && user && currentPageName() !== "admin.html") {
      window.location.replace("./admin.html");
    }
  });
}

function initializeLogoutButton() {
  if (!logoutButton) return;

  logoutButton.addEventListener("click", async () => {
    const originalLabel = logoutButton.textContent;
    logoutButton.disabled = true;
    logoutButton.textContent = "Logging out...";

    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      window.location.replace("./login.html");
    }
  });
}

initializeAuthGate();
initializeLogoutButton();

if (loginForm && emailInput && passwordInput) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = loginForm.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    setLoginStatus(statusMessage, "");

    try {
      await loginWithFirebase(emailInput.value, passwordInput.value);
      window.location.replace("./admin.html");
    } catch (error) {
      setLoginStatus(statusMessage, getFriendlyErrorMessage(error), true);
      console.warn("Login error:", error);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}
