const screens = {
  groups: document.getElementById("groups"),
  phone: document.getElementById("phone"),
  done: document.getElementById("done"),
};

const phoneInput = document.getElementById("phone-input");
const emailInput = document.getElementById("email-input");
const phoneField = document.getElementById("phone-field");
const emailField = document.getElementById("email-field");
const submitPhone = document.getElementById("submit-phone");
const continueBtn = document.getElementById("continue-btn");
const chosenName = document.getElementById("chosen-name");
const chosenIcon = document.getElementById("chosen-icon");
const phoneError = document.getElementById("phone-error");
const groupStatusText = document.getElementById("group-status-text");
const groupStatusDetail = document.getElementById("group-status-detail");
const waitingIcon = document.getElementById("status-waiting-icon");
const sentIcon = document.getElementById("status-sent-icon");

function showScreen(name) {
  Object.entries(screens).forEach(([key, screen]) => {
    const active = key === name;
    screen.classList.toggle("is-active", active);
    screen.hidden = !active;
  });
  window.scrollTo(0, 0);
  const heading = screens[name].querySelector("h2");
  if (heading) heading.focus({ preventScroll: true });
}

function digitsOnly(value) {
  return value.replace(/\D/g, "").slice(0, 10);
}

function formatPhone(digits) {
  if (digits.length < 4) return digits.length ? `(${digits}` : "";
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)} - ${digits.slice(6)}`;
}

function selectedGroup() {
  return document.querySelector('input[name="group"]:checked');
}

document.querySelectorAll('input[name="group"]').forEach((input) => {
  input.addEventListener("change", () => {
    continueBtn.disabled = !selectedGroup();
  });
});

function groupCountLabel(count) {
  return count === 1 ? "1 group created" : `${count} groups created`;
}

async function loadGroupCounts() {
  try {
    const response = await fetch("/api/counts");
    if (!response.ok) return;
    const data = await response.json();
    const total = document.getElementById("group-total");
    if (total) total.textContent = groupCountLabel(data.total || 0);
  } catch {
    // The home page still works if the count cannot be loaded.
  }
}

loadGroupCounts();

document.getElementById("group-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selectedGroup()) return;
  showScreen("phone");
});

let contactMode = "phone";

function validEmail(value) {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function refreshSubmit() {
  const ready = contactMode === "email"
    ? validEmail(emailInput.value)
    : digitsOnly(phoneInput.value).length === 10;
  submitPhone.disabled = !ready;
  submitPhone.classList.toggle("is-ready", ready);
}

document.querySelectorAll("[data-contact]").forEach((button) => {
  button.addEventListener("click", () => {
    contactMode = button.dataset.contact;
    document.querySelectorAll("[data-contact]").forEach((option) => {
      const selected = option === button;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    phoneField.hidden = contactMode !== "phone";
    emailField.hidden = contactMode !== "email";
    phoneError.hidden = true;
    refreshSubmit();
  });
});

phoneInput.addEventListener("input", () => {
  const digits = digitsOnly(phoneInput.value);
  phoneInput.value = formatPhone(digits);
  refreshSubmit();
});

emailInput.addEventListener("input", refreshSubmit);

function resetSignup() {
  contactMode = "phone";
  phoneInput.value = "";
  emailInput.value = "";
  phoneField.hidden = false;
  emailField.hidden = true;
  document.querySelectorAll("[data-contact]").forEach((option) => {
    const selected = option.dataset.contact === "phone";
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
  submitPhone.disabled = true;
  submitPhone.classList.remove("is-ready");
  submitPhone.textContent = "Submit";
  document.querySelectorAll('input[name="group"]').forEach((input) => {
    input.checked = false;
  });
  continueBtn.disabled = true;
}

function showGroupResult(result) {
  const grouped = result.status === "grouped";
  waitingIcon.hidden = grouped;
  sentIcon.hidden = !grouped;

  if (result.status === "waiting") {
    const count = result.waitingCount;
    const people = count === 1 ? "person" : "people";
    groupStatusText.textContent = "Waiting for a group";
    groupStatusDetail.textContent = result.alreadyWaiting
      ? `This ${contactMode === "email" ? "email" : "phone number"} is already waiting for ${result.interest}. It will not be added again unless you start over and submit it for a new group.`
      : `${count} ${people} so far. A GroupMe is created when ${result.groupMin} to ${result.groupMax} people have chosen ${result.interest}.`;
    return;
  }

  const others = result.size - 1;
  const noun = others === 1 ? "person" : "people";
  if (result.textStatus === "sent") {
    groupStatusText.textContent = "GroupMe created";
    setDetail(
      `You and ${others} other ${noun} who chose ${result.interest} are in a new GroupMe.`,
      result.groupmeUrl,
    );
    return;
  }

  groupStatusText.textContent = "Group ready";
  groupStatusDetail.textContent = result.textStatus === "unconfigured"
    ? `You and ${others} other ${noun} chose ${result.interest}. The group is saved, and the GroupMe will be created once Make.com is set up.`
    : `You and ${others} other ${noun} chose ${result.interest}. The GroupMe could not be created.`;
}

function setDetail(text, url) {
  groupStatusDetail.replaceChildren(document.createTextNode(text));
  if (!url) return;
  groupStatusDetail.append(document.createTextNode(" "));
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open your GroupMe";
  groupStatusDetail.append(link);
}

document.getElementById("phone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const digits = digitsOnly(phoneInput.value);
  const email = emailInput.value.trim().toLowerCase();
  const usingEmail = contactMode === "email";
  if (usingEmail ? !validEmail(email) : digits.length !== 10) return;

  const selected = selectedGroup();
  const option = selected.closest(".option");
  phoneError.hidden = true;
  submitPhone.disabled = true;
  submitPhone.textContent = "Submitting...";

  try {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usingEmail
        ? { email, interest: selected.value }
        : { phone: digits, interest: selected.value }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "We couldn't save your information.");
    }

    document.getElementById("done-title").textContent = usingEmail ? "Email submitted!" : "Number submitted!";
    chosenName.textContent = selected.value;
    chosenIcon.innerHTML = option.querySelector(".option-icon").innerHTML;
    showGroupResult(result);
    resetSignup();
    showScreen("done");
  } catch (error) {
    phoneError.hidden = false;
    phoneError.textContent = error.message === "Failed to fetch"
      ? "We couldn't save your information. Open this site from the Rex Connect server and try again."
      : error.message;
    submitPhone.disabled = false;
    submitPhone.classList.add("is-ready");
    submitPhone.textContent = "Submit";
  }
});

document.querySelectorAll("[data-goto]").forEach((button) => {
  button.addEventListener("click", () => {
    showScreen(button.dataset.goto);
  });
});
