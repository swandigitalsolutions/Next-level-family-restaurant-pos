"""Money rules and the retry/double-click safety around them.

These are the paths where a bug costs the restaurant real cash: a bill written
twice, a table settled twice, a discount that does not add up, a bill number
that repeats.
"""

from conftest import data, first_alcohol_item, first_food_item, login, new_ref


def test_food_bill_totals_and_no_tax(client):
    login(client)
    item = first_food_item(client)
    bill = data(client.post("/api/food/bills", json={
        "items": [{"item_id": item["id"], "name": item["name"], "price": 100, "qty": 3}],
        "discount": 50, "tax_percent": 0, "payment_method": "Cash",
    }))
    assert bill["subtotal"] == 300
    assert bill["discount"] == 50
    assert bill["tax"] == 0
    assert bill["grand_total"] == 250


def test_discount_cannot_exceed_subtotal(client):
    login(client)
    item = first_food_item(client)
    res = client.post("/api/food/bills", json={
        "items": [{"item_id": item["id"], "name": item["name"], "price": 100, "qty": 1}],
        "discount": 500,
    })
    assert res.status_code == 400
    assert "Discount" in res.get_json()["error"]


def test_alcohol_bill_carries_tax(client):
    login(client)
    item = first_alcohol_item(client)
    bill = data(client.post("/api/alcohol/bills", json={
        "items": [{"item_id": item["id"], "name": item["name"], "price": 200,
                   "qty": 2, "tax_rate": 18}],
        "discount": 0, "payment_method": "Card",
    }))
    assert bill["subtotal"] == 400
    assert bill["tax"] == 72
    assert bill["grand_total"] == 472


def test_retried_bill_post_creates_exactly_one_bill(client):
    """A repeated POST carrying the same Idempotency-Key is the same sale."""
    login(client)
    item = first_food_item(client)
    payload = {
        "items": [{"item_id": item["id"], "name": item["name"], "price": 120, "qty": 1}],
        "discount": 0, "tax_percent": 0,
    }
    ref = new_ref()

    first = client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": ref})
    second = client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": ref})

    assert first.status_code == 201
    assert second.status_code == 200, "a retry must not create a second bill"
    assert data(first)["bill_no"] == data(second)["bill_no"]
    assert data(first)["id"] == data(second)["id"]

    bills = data(client.get("/api/food/bills"))
    assert len([b for b in bills if b["bill_no"] == data(first)["bill_no"]]) == 1


def test_different_keys_create_different_bills(client):
    login(client)
    item = first_food_item(client)
    payload = {
        "items": [{"item_id": item["id"], "name": item["name"], "price": 120, "qty": 1}],
        "discount": 0, "tax_percent": 0,
    }
    one = data(client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": new_ref()}))
    two = data(client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": new_ref()}))
    assert one["bill_no"] != two["bill_no"]


def test_bill_numbers_never_repeat_or_skip(client):
    login(client)
    item = first_food_item(client)
    numbers = []
    for _ in range(12):
        bill = data(client.post("/api/food/bills", json={
            "items": [{"item_id": item["id"], "name": item["name"], "price": 10, "qty": 1}],
        }))
        numbers.append(int(bill["bill_no"].split("-")[1]))
    assert numbers == list(range(1, 13))


# ---------------------------------------------------------------- table flow

def open_table_with_items(client, items):
    table = data(client.get("/api/tables"))[0]
    session = data(client.post(f"/api/tables/{table['id']}/open", json={"customer_name": "Guest"}))
    data(client.put(f"/api/table-sessions/{session['id']}", json={"items": items}))
    return table, session


def test_settlement_splits_food_and_alcohol_into_separate_bills(client):
    login(client)
    _, session = open_table_with_items(client, [
        {"name": "Biryani", "price": 200, "qty": 2, "tax_rate": 0, "item_kind": "food"},
        {"name": "Beer", "price": 100, "qty": 1, "tax_rate": 10, "item_kind": "alcohol"},
    ])
    settled = data(client.post(f"/api/table-sessions/{session['id']}/settle",
                               json={"payment_method": "Cash", "discount": 0}))
    kinds = sorted(b["type"] for b in settled["bills"])
    assert kinds == ["ALCOHOL", "FOOD"]
    assert settled["subtotal"] == 500
    assert settled["tax"] == 10          # only the alcohol line is taxed
    assert settled["grand_total"] == 510


def test_split_discount_sums_back_exactly(client):
    """Pro-rata shares are rounded; the parts must still add up to the whole."""
    login(client)
    _, session = open_table_with_items(client, [
        {"name": "Curry", "price": 33.33, "qty": 1, "tax_rate": 0, "item_kind": "food"},
        {"name": "Rum", "price": 66.67, "qty": 1, "tax_rate": 0, "item_kind": "alcohol"},
    ])
    settled = data(client.post(f"/api/table-sessions/{session['id']}/settle",
                               json={"discount": 10.01}))
    food = data(client.get(f"/api/food/bills/{[b for b in settled['bills'] if b['type'] == 'FOOD'][0]['id']}"))
    alc = data(client.get(f"/api/alcohol/bills/{[b for b in settled['bills'] if b['type'] == 'ALCOHOL'][0]['id']}"))
    assert round(food["discount"] + alc["discount"], 2) == 10.01


def test_settling_twice_does_not_bill_twice(client):
    login(client)
    _, session = open_table_with_items(client, [
        {"name": "Dosa", "price": 100, "qty": 1, "tax_rate": 0, "item_kind": "food"},
    ])
    first = client.post(f"/api/table-sessions/{session['id']}/settle", json={"discount": 0})
    second = client.post(f"/api/table-sessions/{session['id']}/settle", json={"discount": 0})

    assert first.status_code == 201
    assert second.status_code == 200, "the second settle must be a no-op, not an error"
    assert data(second)["already_settled"] is True
    assert [b["id"] for b in data(first)["bills"]] == [b["id"] for b in data(second)["bills"]]
    assert len(data(client.get("/api/food/bills"))) == 1


def test_opening_the_same_table_twice_reuses_one_session(client):
    login(client)
    table = data(client.get("/api/tables"))[0]
    one = data(client.post(f"/api/tables/{table['id']}/open", json={}))
    two = data(client.post(f"/api/tables/{table['id']}/open", json={}))
    assert one["id"] == two["id"]


def test_empty_table_cannot_be_settled(client):
    login(client)
    table = data(client.get("/api/tables"))[0]
    session = data(client.post(f"/api/tables/{table['id']}/open", json={}))
    res = client.post(f"/api/table-sessions/{session['id']}/settle", json={})
    assert res.status_code == 400


def test_stock_is_decremented_once_per_sale(client):
    login(client)
    item = first_food_item(client)
    data(client.put(f"/api/food/items/{item['id']}", json={"stock_qty": 10}))
    ref = new_ref()
    payload = {"items": [{"item_id": item["id"], "name": item["name"],
                          "price": item["price"], "qty": 3}]}
    client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": ref})
    client.post("/api/food/bills", json=payload, headers={"Idempotency-Key": ref})
    after = [i for i in data(client.get("/api/food/items")) if i["id"] == item["id"]][0]
    assert after["stock_qty"] == 7, "a retried bill must not decrement stock twice"
