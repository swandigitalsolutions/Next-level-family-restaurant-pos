"""Authorization boundaries, the public QR surface, and failure behaviour."""

import json

from conftest import data, first_food_item, login


# ------------------------------------------------------------------- auth

def test_unauthenticated_requests_are_rejected(client):
    for path in ("/api/dashboard", "/api/food/items", "/api/staff", "/api/orders"):
        assert client.get(path).status_code == 401, path


def test_login_is_throttled_after_repeated_failures(client):
    for _ in range(6):
        client.post("/api/login", json={"username": "admin", "password": "wrong"})
    res = client.post("/api/login", json={"username": "admin", "password": "nextlevel@123"})
    assert res.status_code == 429


def test_login_failure_map_does_not_grow_without_bound(client, monkeypatch):
    """A login flood from many addresses must not grow the process's memory
    forever - this map had no eviction at all."""
    app_module = client.app_module
    monkeypatch.setattr(app_module, "LOGIN_ATTEMPTS_MAX_KEYS", 50)
    app_module._LOGIN_ATTEMPTS.clear()
    for i in range(5000):
        app_module._register_login_failure(f"10.{i // 256}.{i % 256}.1")
    assert len(app_module._LOGIN_ATTEMPTS) <= 100, len(app_module._LOGIN_ATTEMPTS)


def test_deactivated_account_cannot_log_in(client):
    login(client)
    created = data(client.post("/api/staff", json={
        "username": "cashier1", "password": "secret123",
        "full_name": "Cashier One", "role": "staff",
    }))
    client.post("/api/staff/%d" % created["id"], json={})  # no-op
    data(client.put(f"/api/staff/{created['id']}", json={"status": "inactive"}))
    client.post("/api/logout")
    res = client.post("/api/login", json={"username": "cashier1", "password": "secret123"})
    assert res.status_code == 403


def test_staff_role_cannot_manage_staff_or_catalog(client):
    login(client)
    data(client.post("/api/staff", json={
        "username": "cashier2", "password": "secret123",
        "full_name": "Cashier Two", "role": "staff",
    }))
    client.post("/api/logout")
    login(client, "cashier2", "secret123")
    assert client.get("/api/staff").status_code == 403
    assert client.post("/api/food/categories", json={"name": "X"}).status_code == 403
    # ...but billing, which is their job, still works.
    assert client.get("/api/food/items").status_code == 200


def test_owner_is_view_only_everywhere(client):
    login(client, "owner", "owner@123")
    assert client.get("/api/dashboard").status_code == 200
    assert client.get("/api/food/items").status_code == 403
    assert client.post("/api/food/bills", json={"items": []}).status_code == 403
    assert client.get("/api/staff").status_code == 403


def test_last_active_admin_cannot_be_demoted(client):
    user = login(client)
    res = client.put(f"/api/staff/{user['id']}", json={"role": "staff"})
    assert res.status_code == 400
    assert "admin" in res.get_json()["error"]


def test_website_menu_requires_an_api_key(client):
    assert client.get("/api/website/menu").status_code == 401
    assert client.get("/api/website/menu", headers={"X-API-Key": "nope"}).status_code == 401


# --------------------------------------------------------------- QR ordering

def qr_token(client):
    login(client)
    table = data(client.get("/api/qr-ordering/tables"))[0]
    client.post("/api/logout")
    return table["qr_token"], table["id"]


def test_qr_order_is_repriced_from_the_live_menu(client):
    login(client)
    item = first_food_item(client)
    data(client.put(f"/api/food/items/{item['id']}", json={"price": 250}))
    token, _ = qr_token(client)

    order = data(client.post("/api/qr/orders", json={
        "token": token,
        "items": [{"id": item["id"], "kind": "food", "qty": 2, "price": 1}],
    }))
    assert order["items"][0]["price"] == 250, "the price the browser sent must be ignored"
    assert order["grand_total"] == 500


def test_qr_order_rejects_an_unknown_table_token(client):
    res = client.post("/api/qr/orders", json={"token": "not-a-token", "items": [{"id": 1, "qty": 1}]})
    assert res.status_code == 404


def test_qr_order_rejects_absurd_quantities_and_line_counts(client):
    login(client)
    item = first_food_item(client)
    token, _ = qr_token(client)
    too_many = client.post("/api/qr/orders", json={
        "token": token,
        "items": [{"id": item["id"], "kind": "food", "qty": 1}] * 41,
    })
    assert too_many.status_code == 400
    huge_qty = client.post("/api/qr/orders", json={
        "token": token, "items": [{"id": item["id"], "kind": "food", "qty": 9999}],
    })
    assert huge_qty.status_code == 400


def test_qr_ordering_is_rate_limited_per_table(client):
    login(client)
    item = first_food_item(client)
    token, _ = qr_token(client)
    body = {"token": token, "items": [{"id": item["id"], "kind": "food", "qty": 1}]}
    codes = [client.post("/api/qr/orders", json=body).status_code for _ in range(20)]
    assert 429 in codes, "a flood from one table must eventually be refused"
    assert codes[0] == 201, "normal ordering still works"


def test_pushing_a_qr_order_to_a_bill_twice_adds_the_items_once(client):
    login(client)
    item = first_food_item(client)
    token, table_id = qr_token(client)
    login(client)
    order = data(client.post("/api/qr/orders", json={
        "token": token, "items": [{"id": item["id"], "kind": "food", "qty": 2}],
    }))

    first = client.post(f"/api/qr-ordering/orders/{order['id']}/push-to-bill")
    second = client.post(f"/api/qr-ordering/orders/{order['id']}/push-to-bill")
    assert first.status_code == 200
    assert second.status_code == 400, "the second push must be refused"

    session_id = data(first)["table_session_id"]
    session = data(client.get(f"/api/table-sessions/{session_id}"))
    assert len(session["items"]) == 1
    assert session["items"][0]["qty"] == 2


# --------------------------------------------------------- failure behaviour

def test_errors_are_always_json_not_html(client):
    """apiFetch parses every response as JSON; an HTML error page is useless."""
    res = client.get("/api/definitely-not-a-route")
    assert res.status_code == 404
    assert res.get_json()["success"] is False

    res = client.delete("/api/health")
    assert res.status_code == 405
    assert res.get_json()["success"] is False


def test_unhandled_exception_returns_a_clean_json_error(client):
    app_module = client.app_module

    @app_module.app.route("/api/_boom")
    def _boom():
        raise RuntimeError("secret internal detail")

    login(client)
    res = client.get("/api/_boom")
    assert res.status_code == 500
    body = res.get_json()
    assert body["success"] is False
    assert "secret internal detail" not in json.dumps(body), "internals must not leak"


def test_a_failing_request_releases_its_db_connection(client, monkeypatch):
    """The leak that used to exhaust the Postgres pool and take the till offline.

    Every connection handed out must come back, including when the handler
    raises. The counters below stand in for the pool's free list.
    """
    app_module = client.app_module
    opened, closed = [], []
    real_open = app_module._open_db

    class CountingConn:
        def __init__(self, conn):
            self._conn = conn

        def __getattr__(self, name):
            return getattr(self._conn, name)

        def close(self):
            closed.append(self)
            return self._conn.close()

    def counting_open():
        conn = CountingConn(real_open())
        opened.append(conn)
        return conn

    monkeypatch.setattr(app_module, "_open_db", counting_open)

    @app_module.app.route("/api/_boom_db")
    def _boom_db():
        app_module.get_db().execute("SELECT 1")
        raise RuntimeError("blow up mid-request")

    login(client)
    opened.clear()
    closed.clear()
    for _ in range(30):
        assert client.get("/api/_boom_db").status_code == 500

    assert len(opened) == 30
    assert len(closed) == 30, "every connection must be returned, even on the error path"
    # And normal traffic still works afterwards.
    assert client.get("/api/dashboard").status_code == 200


def test_one_request_uses_exactly_one_connection(client, monkeypatch):
    """Handlers that call get_db() more than once must share, not stack up."""
    app_module = client.app_module
    opened = []
    real_open = app_module._open_db
    monkeypatch.setattr(app_module, "_open_db",
                        lambda: (opened.append(1), real_open())[1])
    login(client)
    opened.clear()
    assert client.get("/api/reports/export?type=all").status_code == 200
    assert len(opened) == 1


def test_csv_export_neutralises_spreadsheet_formulas(client):
    login(client)
    item = first_food_item(client)
    data(client.post("/api/food/bills", json={
        "items": [{"item_id": item["id"], "name": item["name"], "price": 10, "qty": 1}],
        "customer_name": "=HYPERLINK(\"http://evil\",\"click\")",
    }))
    res = client.get("/api/reports/export?type=food")
    assert res.status_code == 200
    text = res.data.decode()
    assert "=HYPERLINK" in text
    assert "'=HYPERLINK" in text, "the cell must be quoted so Excel treats it as text"
