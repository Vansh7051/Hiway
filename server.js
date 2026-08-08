from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
import time

app = Flask(__name__)
# Enable CORS for frontend interactions
CORS(app)

DB_FILE = 'chips_database.json'

def read_db():
    if not os.path.exists(DB_FILE):
        with open(DB_FILE, 'w') as f:
            json.dump({"chips": []}, f, indent=2)
    try:
        with open(DB_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return {"chips": []}

def write_db(data):
    with open(DB_FILE, 'w') as f:
        json.dump(data, f, indent=2)

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "online", "server": "Velocit Backend"}), 200

# -------------------------------------------------------------------
# 1. CHIP HEARTBEAT / PING (Called automatically by physical ESP device)
# -------------------------------------------------------------------
@app.route('/api/chips/ping', methods=['POST'])
def chip_ping():
    try:
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()
        ip_address = data.get('ipAddress', 'unassigned').strip()

        if not chip_name or not chip_password:
            return jsonify({"success": False, "error": "Missing chipName or chipPassword"}), 400

        db = read_db()
        existing_index = next((i for i, c in enumerate(db['chips']) if c.get('chipName') == chip_name), -1)

        record = {
            "chipName": chip_name,
            "chipPassword": chip_password,
            "ipAddress": ip_address,
            "lastSeen": time.time()  # Unix timestamp
        }

        if existing_index != -1:
            db['chips'][existing_index] = record
        else:
            db['chips'].append(record)

        write_db(db)
        return jsonify({"success": True, "message": f"Heartbeat received for {chip_name}", "chip": record}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# -------------------------------------------------------------------
# 2. VERIFY CHIP & CHECK ONLINE STATUS (Used by Hamburger Menu)
# -------------------------------------------------------------------
@app.route('/api/chips/verify', methods=['POST'])
def verify_chip():
    try:
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()

        db = read_db()
        target = next((c for c in db['chips'] if c.get('chipName') == chip_name and c.get('chipPassword') == chip_password), None)

        if not target:
            return jsonify({
                "success": False, 
                "error": "Access Denied: Chip not registered or invalid password."
            }), 401

        # Determine if Online (pinged within the last 45 seconds)
        last_seen = target.get('lastSeen', 0)
        current_time = time.time()
        is_online = (current_time - last_seen) < 45

        return jsonify({
            "success": True,
            "chipName": target['chipName'],
            "isOnline": is_online,
            "ipAddress": target.get('ipAddress', 'unassigned')
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# -------------------------------------------------------------------
# 3. DISPATCH COMMAND / CODE UPLOAD (Strictly Online Chips Only)
# -------------------------------------------------------------------
@app.route('/api/chips/dispatch', methods=['POST'])
def dispatch_command():
    try:
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()
        command = data.get('command', '')

        db = read_db()
        target = next((c for c in db['chips'] if c.get('chipName') == chip_name and c.get('chipPassword') == chip_password), None)

        if not target:
            return jsonify({"success": False, "error": "Access Denied: Unregistered chip credentials."}), 401

        # Check if powered ON
        last_seen = target.get('lastSeen', 0)
        is_online = (time.time() - last_seen) < 45

        if not is_online:
            return jsonify({"success": False, "error": "Upload/Command Blocked: Chip is currently OFFLINE."}), 400

        # Execute upload/command logic here
        return jsonify({
            "success": True, 
            "message": f"Successfully delivered action '{command}' to {chip_name}!"
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    app.run(host='0.0.0.0', port=port)
  
