"""What happens when several billing terminals act at the same instant.

These are the cases a single-threaded test suite cannot see and a busy Friday
night finds immediately: two cashiers settling the same table, a double-tap on
"Save", two terminals opening the same table. They only mean something against
Postgres (SQLite serialises writes on one file anyway), so they are skipped
unless TEST_DATABASE_URL points at a real cluster.
"""

import threading

import pytest

from conftest import TEST_DATABASE_URL, data, first_food_item, login

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="concurrency behaviour is only meaningful on Postgres; set TEST_DATABASE_URL",
)


def run_concurrently(app_module, make_request, count):
    """Fire `count` real requests at once, each on its own thread/connection."""
    results = [None] * count
    barrier = threading.Barrier(count)

    def worker(index):
        client = app_module.app.test_client()
        client.post("/api/login", json={"username": "admin", "password": "nextlevel@123"})
        barrier.wait()
        try:
            results[index] = make_request(client, index)
        except Exception as exc:  # noqa: BLE001 - reported by the assertions
            results[index] = exc

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    return results


def test_concurrent_bills_never_reuse_or_skip_a_bill_number(client):
    login(client)
    item = first_food_item(client)
    app_module = client.app_module

    def make_bill(c, _index):
        return c.post("/api/food/bills", json={
            "items": [{"item_id": item["id"], "name": item["name"], "price": 50, "qty": 1}],
        })

    results = run_concurrently(app_module, make_bill, 8)
    numbers = []
    for res in results:
        assert not isinstance(res, Exception), res
        assert res.status_code == 201, res.get_json()
        numbers.append(int(res.get_json()["data"]["bill_no"].split("-")[1]))

    assert sorted(numbers) == list(range(1, 9)), f"gap or duplicate: {sorted(numbers)}"


def test_concurrent_settlement_of_one_table_produces_one_set_of_bills(client):
    login(client)
    app_module = client.app_module
    table = data(client.get("/api/tables"))[0]
    session = data(client.post(f"/api/tables/{table['id']}/open", json={}))
    data(client.put(f"/api/table-sessions/{session['id']}", json={"items": [
        {"name": "Thali", "price": 300, "qty": 2, "tax_rate": 0, "item_kind": "food"},
    ]}))

    def settle(c, _index):
        return c.post(f"/api/table-sessions/{session['id']}/settle", json={"discount": 0})

    results = run_concurrently(app_module, settle, 6)
    for res in results:
        assert not isinstance(res, Exception), res
        assert res.status_code in (200, 201), res.get_json()

    bills = data(client.get("/api/food/bills"))
    assert len(bills) == 1, f"the table was billed {len(bills)} times"
    assert float(bills[0]["grand_total"]) == 600


def test_concurrent_opens_of_one_table_produce_one_session(client):
    login(client)
    app_module = client.app_module
    table = data(client.get("/api/tables"))[0]

    def open_table(c, _index):
        return c.post(f"/api/tables/{table['id']}/open", json={})

    results = run_concurrently(app_module, open_table, 6)
    session_ids = set()
    for res in results:
        assert not isinstance(res, Exception), res
        assert res.status_code in (200, 201), res.get_json()
        session_ids.add(res.get_json()["data"]["id"])

    assert len(session_ids) == 1, f"the table has {len(session_ids)} open sessions"


def test_concurrent_retries_of_one_sale_create_one_bill(client):
    """The same Idempotency-Key arriving twice at once - a genuine double-tap."""
    login(client)
    item = first_food_item(client)
    app_module = client.app_module
    payload = {"items": [{"item_id": item["id"], "name": item["name"], "price": 75, "qty": 1}]}

    def save(c, _index):
        return c.post("/api/food/bills", json=payload,
                      headers={"Idempotency-Key": "same-key-for-one-sale"})

    results = run_concurrently(app_module, save, 6)
    for res in results:
        assert not isinstance(res, Exception), res
        assert res.status_code in (200, 201), res.get_json()

    bills = data(client.get("/api/food/bills"))
    assert len(bills) == 1, f"one sale produced {len(bills)} bills"


def test_concurrent_pushes_of_one_qr_order_add_its_items_once(client):
    login(client)
    item = first_food_item(client)
    app_module = client.app_module
    qr_table = data(client.get("/api/qr-ordering/tables"))[0]
    order = data(client.post("/api/qr/orders", json={
        "token": qr_table["qr_token"],
        "items": [{"id": item["id"], "kind": "food", "qty": 3}],
    }))

    def push(c, _index):
        return c.post(f"/api/qr-ordering/orders/{order['id']}/push-to-bill")

    results = run_concurrently(app_module, push, 5)
    accepted = [r for r in results if not isinstance(r, Exception) and r.status_code == 200]
    assert len(accepted) == 1, "exactly one push should win"

    session_id = accepted[0].get_json()["data"]["table_session_id"]
    session = data(client.get(f"/api/table-sessions/{session_id}"))
    assert sum(int(i["qty"]) for i in session["items"]) == 3
