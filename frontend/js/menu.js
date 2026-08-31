(async function initMenu() {
  const user = await requireAuth();
  if (!user) return;
  renderSidebar("menu", user);

  let FOOD_CATS = [];
  let FOOD_ITEMS = [];
  let ALCOHOL_CATS = [];
  let ALCOHOL_ITEMS = [];

  // ---------------- Tabs ----------------
  document.querySelectorAll(".menu-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".menu-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".menu-panel-section").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    });
  });

  // ---------------- Load everything ----------------
  async function loadAll() {
    try {
      const [foodCats, foodItems, alcCats, alcItems] = await Promise.all([
        apiFetch("/food/categories"),
        apiFetch("/food/items"),
        apiFetch("/alcohol/categories"),
        apiFetch("/alcohol/items"),
      ]);
      FOOD_CATS = foodCats;
      FOOD_ITEMS = foodItems;
      ALCOHOL_CATS = alcCats;
      ALCOHOL_ITEMS = alcItems;

      renderFoodCatSelect();
      renderFoodCats();
      renderFoodItems();
      renderAlcoholCatSelect();
      renderAlcoholCats();
      renderAlcoholItems();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ================================================================
  // FOOD CATEGORIES
  // ================================================================

  function renderFoodCatSelect() {
    const sel = document.getElementById("foodItemCategorySelect");
    const active = FOOD_CATS.filter(c => c.status === "active");
    sel.innerHTML = active.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }

  function renderFoodCats() {
    const body = document.getElementById("foodCatsBody");
    const categoryCount = FOOD_CATS.filter(c => c.status === "active").length + ALCOHOL_CATS.filter(c => c.status === "active").length;
    document.getElementById("menuCategoryCount").textContent = categoryCount;
    if (FOOD_CATS.length === 0) {
      body.innerHTML = `<tr><td colspan="3" class="empty-state">No food categories yet.</td></tr>`;
      return;
    }
    body.innerHTML = FOOD_CATS.map(c => `
      <tr data-id="${c.id}">
        <td class="cell-name">${escapeHtml(c.name)}</td>
        <td><span class="tag ${c.status === 'active' ? 'tag-active' : 'tag-inactive'}">${c.status}</span></td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm act-edit-cat" data-type="food">Edit</button>
          <button class="btn btn-danger btn-sm act-delete-cat" data-type="food">Delete</button>
        </td>
      </tr>
    `).join("");
    wireCategoryRowActions(body, "food");
  }

  function renderAlcoholCatSelect() {
    const sel = document.getElementById("alcoholItemCategorySelect");
    const active = ALCOHOL_CATS.filter(c => c.status === "active");
    sel.innerHTML = active.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }

  function renderAlcoholCats() {
    const body = document.getElementById("alcoholCatsBody");
    if (ALCOHOL_CATS.length === 0) {
      body.innerHTML = `<tr><td colspan="3" class="empty-state">No alcohol categories yet.</td></tr>`;
      return;
    }
    body.innerHTML = ALCOHOL_CATS.map(c => `
      <tr data-id="${c.id}">
        <td class="cell-name">${escapeHtml(c.name)}</td>
        <td><span class="tag ${c.status === 'active' ? 'tag-active' : 'tag-inactive'}">${c.status}</span></td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm act-edit-cat" data-type="alcohol">Edit</button>
          <button class="btn btn-danger btn-sm act-delete-cat" data-type="alcohol">Delete</button>
        </td>
      </tr>
    `).join("");
    wireCategoryRowActions(body, "alcohol");
  }

  function wireCategoryRowActions(body, type) {
    body.querySelectorAll(".act-edit-cat").forEach(btn => {
      btn.addEventListener("click", () => startEditCategory(btn.closest("tr"), type));
    });
    body.querySelectorAll(".act-delete-cat").forEach(btn => {
      btn.addEventListener("click", () => deleteCategory(btn.closest("tr").dataset.id, type));
    });
  }

  function startEditCategory(row, type) {
    const id = row.dataset.id;
    const list = type === "food" ? FOOD_CATS : ALCOHOL_CATS;
    const cat = list.find(c => String(c.id) === String(id));
    if (!cat) return;

    row.querySelector(".cell-name").innerHTML =
      `<input class="edit-input" value="${escapeHtml(cat.name)}" />`;
    const actionsCell = row.querySelector(".row-actions");
    actionsCell.innerHTML = `
      <button class="btn btn-primary btn-sm act-save-cat">Save</button>
      <button class="btn btn-outline btn-sm act-cancel-cat">Cancel</button>
    `;
    actionsCell.querySelector(".act-save-cat").addEventListener("click", async () => {
      const newName = row.querySelector(".edit-input").value.trim();
      if (!newName) { showToast("Category name is required", true); return; }
      try {
        await apiFetch(`/${type}/categories/${id}`, { method: "PUT", body: { name: newName } });
        showToast("Category updated");
        await loadAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsCell.querySelector(".act-cancel-cat").addEventListener("click", () => {
      if (type === "food") renderFoodCats(); else renderAlcoholCats();
    });
  }

  async function deleteCategory(id, type) {
    if (!confirm("Delete this category? It must have no active items.")) return;
    try {
      await apiFetch(`/${type}/categories/${id}`, { method: "DELETE" });
      showToast("Category deleted");
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.getElementById("foodCatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try {
      await apiFetch("/food/categories", { method: "POST", body: { name } });
      showToast("Food category added");
      e.target.reset();
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("alcoholCatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try {
      await apiFetch("/alcohol/categories", { method: "POST", body: { name } });
      showToast("Alcohol category added");
      e.target.reset();
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ================================================================
  // FOOD ITEMS
  // ================================================================

  function renderFoodItems() {
    const body = document.getElementById("foodItemsBody");
    const query = (document.getElementById("foodCatalogSearch")?.value || "").toLowerCase().trim();
    const filtered = FOOD_ITEMS.filter(i => !query || `${i.name} ${i.category_name}`.toLowerCase().includes(query));
    document.getElementById("foodTabCount").textContent = FOOD_ITEMS.length;
    document.getElementById("menuFoodCount").textContent = FOOD_ITEMS.filter(i => i.status === "active").length;
    if (filtered.length === 0) {
      body.innerHTML = `<div class="empty-state card-empty">${query ? "No food items match that search." : "No food items yet."}</div>`;
      return;
    }
    body.innerHTML = filtered.map(i => `
      <article class="menu-admin-card" data-id="${i.id}">
        <div class="admin-card-image"><img src="${menuImage(i)}" alt="${escapeHtml(i.name)}" loading="lazy" decoding="async"><span class="admin-card-status ${i.status === 'active' ? 'is-active' : ''}">${i.status}</span></div>
        <div class="admin-card-body"><div class="admin-card-kicker cell-category">${escapeHtml(i.category_name)}</div><div class="cell-name admin-card-name">${escapeHtml(i.name)}</div><div class="admin-card-footer"><span class="cell-price admin-card-price">${formatMoney(i.price)}</span><div class="row-actions"><button class="btn btn-outline btn-sm act-edit-item">Edit</button><button class="btn btn-danger btn-sm act-delete-item">Delete</button></div></div></div>
      </article>
    `).join("");
    body.querySelectorAll(".act-edit-item").forEach(btn => btn.addEventListener("click", () => startEditFoodItem(btn.closest(".menu-admin-card"))));
    body.querySelectorAll(".act-delete-item").forEach(btn => btn.addEventListener("click", () => deleteFoodItem(btn.closest(".menu-admin-card").dataset.id)));
  }

  function startEditFoodItem(row) {
    const id = row.dataset.id;
    const item = FOOD_ITEMS.find(i => String(i.id) === String(id));
    if (!item) return;

    const catOptions = FOOD_CATS.filter(c => c.status === "active")
      .map(c => `<option value="${c.id}" ${c.id === item.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");

    row.querySelector(".cell-name").innerHTML = `<input class="edit-input edit-name" value="${escapeHtml(item.name)}" />`;
    row.querySelector(".cell-category").innerHTML = `<select class="edit-input edit-cat">${catOptions}</select>`;
    row.querySelector(".cell-price").innerHTML = `<input class="edit-input edit-price" type="number" step="0.01" min="0" value="${item.price}" />`;

    const actionsCell = row.querySelector(".row-actions");
    actionsCell.innerHTML = `
      <button class="btn btn-primary btn-sm act-save-item">Save</button>
      <button class="btn btn-outline btn-sm act-cancel-item">Cancel</button>
    `;
    actionsCell.querySelector(".act-save-item").addEventListener("click", async () => {
      const name = row.querySelector(".edit-name").value.trim();
      const category_id = Number(row.querySelector(".edit-cat").value);
      const price = row.querySelector(".edit-price").value;
      if (!name) { showToast("Item name is required", true); return; }
      try {
        await apiFetch(`/food/items/${id}`, { method: "PUT", body: { name, category_id, price } });
        showToast("Item updated");
        await loadAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsCell.querySelector(".act-cancel-item").addEventListener("click", renderFoodItems);
  }

  async function deleteFoodItem(id) {
    if (!confirm("Remove this food item from the menu?")) return;
    try {
      await apiFetch(`/food/items/${id}`, { method: "DELETE" });
      showToast("Item removed");
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.getElementById("foodItemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim(),
      category_id: Number(form.category_id.value),
      price: form.price.value,
    };
    if (!payload.name || !payload.category_id) {
      showToast("Name and category are required", true);
      return;
    }
    try {
      await apiFetch("/food/items", { method: "POST", body: payload });
      showToast("Food item added");
      form.reset();
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ================================================================
  // ALCOHOL ITEMS
  // ================================================================

  function renderAlcoholItems() {
    const body = document.getElementById("alcoholItemsBody");
    const query = (document.getElementById("alcoholCatalogSearch")?.value || "").toLowerCase().trim();
    const filtered = ALCOHOL_ITEMS.filter(i => !query || `${i.name} ${i.category_name} ${i.brand || ""}`.toLowerCase().includes(query));
    document.getElementById("alcoholTabCount").textContent = ALCOHOL_ITEMS.length;
    document.getElementById("menuAlcoholCount").textContent = ALCOHOL_ITEMS.filter(i => i.status === "active").length;
    if (filtered.length === 0) {
      body.innerHTML = `<div class="empty-state card-empty">${query ? "No bar products match that search." : "No bar products yet."}</div>`;
      return;
    }
    body.innerHTML = filtered.map(i => `
      <article class="menu-admin-card" data-id="${i.id}">
        <div class="admin-card-image admin-card-image-bar"><img src="${menuImage(i, "alcohol")}" alt="${escapeHtml(i.name)}" loading="lazy" decoding="async"><span class="admin-card-status ${i.status === 'active' ? 'is-active' : ''}">${i.status}</span></div>
        <div class="admin-card-body"><div class="admin-card-kicker cell-category">${escapeHtml(i.category_name)} · ${escapeHtml(i.bottle_size || "Pour")}</div><div class="cell-name admin-card-name">${escapeHtml(i.name)}</div><div class="admin-card-sub">${escapeHtml(i.brand || "House selection")} · Tax ${i.tax_rate}%</div><div class="admin-card-footer"><span class="cell-price admin-card-price">${formatMoney(i.price)}</span><div class="row-actions"><button class="btn btn-outline btn-sm act-edit-alc">Edit</button><button class="btn btn-danger btn-sm act-delete-alc">Delete</button></div></div></div>
      </article>
    `).join("");
    body.querySelectorAll(".act-edit-alc").forEach(btn => btn.addEventListener("click", () => startEditAlcoholItem(btn.closest(".menu-admin-card"))));
    body.querySelectorAll(".act-delete-alc").forEach(btn => btn.addEventListener("click", () => deleteAlcoholItem(btn.closest(".menu-admin-card").dataset.id)));
  }

  function startEditAlcoholItem(row) {
    const id = row.dataset.id;
    const item = ALCOHOL_ITEMS.find(i => String(i.id) === String(id));
    if (!item) return;

    const catOptions = ALCOHOL_CATS.filter(c => c.status === "active")
      .map(c => `<option value="${c.id}" ${c.id === item.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");

    row.querySelector(".cell-name").innerHTML = `<input class="edit-input edit-name" value="${escapeHtml(item.name)}" />`;
    row.querySelector(".cell-category").innerHTML = `<select class="edit-input edit-cat">${catOptions}</select>`;
    row.querySelector(".cell-brand").innerHTML = `<input class="edit-input edit-brand" value="${escapeHtml(item.brand || "")}" />`;
    row.querySelector(".cell-size").innerHTML = `<input class="edit-input edit-size" value="${escapeHtml(item.bottle_size || "")}" />`;
    row.querySelector(".cell-price").innerHTML = `<input class="edit-input edit-price" type="number" step="0.01" min="0" value="${item.price}" />`;
    row.querySelector(".cell-tax").innerHTML = `<input class="edit-input edit-tax" type="number" step="0.01" min="0" value="${item.tax_rate}" />`;

    const actionsCell = row.querySelector(".row-actions");
    actionsCell.innerHTML = `
      <button class="btn btn-primary btn-sm act-save-alc">Save</button>
      <button class="btn btn-outline btn-sm act-cancel-alc">Cancel</button>
    `;
    actionsCell.querySelector(".act-save-alc").addEventListener("click", async () => {
      const payload = {
        name: row.querySelector(".edit-name").value.trim(),
        category_id: Number(row.querySelector(".edit-cat").value),
        brand: row.querySelector(".edit-brand").value.trim(),
        bottle_size: row.querySelector(".edit-size").value.trim(),
        price: row.querySelector(".edit-price").value,
        tax_rate: row.querySelector(".edit-tax").value,
      };
      if (!payload.name) { showToast("Product name is required", true); return; }
      try {
        await apiFetch(`/alcohol/items/${id}`, { method: "PUT", body: payload });
        showToast("Product updated");
        await loadAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    actionsCell.querySelector(".act-cancel-alc").addEventListener("click", renderAlcoholItems);
  }

  async function deleteAlcoholItem(id) {
    if (!confirm("Remove this alcohol product from the menu?")) return;
    try {
      await apiFetch(`/alcohol/items/${id}`, { method: "DELETE" });
      showToast("Product removed");
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.getElementById("alcoholItemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim(),
      category_id: Number(form.category_id.value),
      brand: form.brand.value.trim(),
      bottle_size: form.bottle_size.value.trim(),
      price: form.price.value,
      tax_rate: form.tax_rate.value || 0,
    };
    if (!payload.name || !payload.category_id) {
      showToast("Product name and category are required", true);
      return;
    }
    try {
      await apiFetch("/alcohol/items", { method: "POST", body: payload });
      showToast("Alcohol product added");
      form.reset();
      await loadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("foodCatalogSearch")?.addEventListener("input", renderFoodItems);
  document.getElementById("alcoholCatalogSearch")?.addEventListener("input", renderAlcoholItems);
  document.getElementById("focusFoodForm")?.addEventListener("click", () => { document.getElementById("foodAddPanel").scrollIntoView({ behavior: "smooth", block: "center" }); document.querySelector('#foodItemForm input[name="name"]').focus(); });
  document.getElementById("focusAlcoholForm")?.addEventListener("click", () => { document.getElementById("alcoholAddPanel").scrollIntoView({ behavior: "smooth", block: "center" }); document.querySelector('#alcoholItemForm input[name="name"]').focus(); });

  // ---------------- Init ----------------
  await loadAll();
})();
