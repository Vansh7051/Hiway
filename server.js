from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import time

app = Flask(__name__)
CORS(app)

# -------------------------------------------------------------------
# IN-MEMORY HEARTBEAT STORE ($0 COST - NO DATABASE NEEDED)
# Stores live ESP8266 pings in server RAM: { "chipName": {...} }
# -------------------------------------------------------------------
live_chips_ram = {}

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "online", "mode": "Stateless Zero-Cost Gateway"}), 200


# -------------------------------------------------------------------
# 1. VERIFY & FETCH USER'S REGISTERED CHIPS (From Google Account)
# -------------------------------------------------------------------
@app.route('/api/user/verify-account-chips', methods=['POST'])
def verify_account_chips():
    try:
        data = request.get_json() or {}
        email = data.get('email', '').strip().lower()
        account_chips = data.get('chips', [])  # Array of chips pulled from user's Google Account

        if not email:
            return jsonify({"success": False, "error": "User email is required."}), 400

        # If user has no chips saved in their Google Account
        if not account_chips:
            return jsonify({
                "success": True,
                "email": email,
                "status": "Not Available",
                "message": "No chips registered under this account.",
                "totalChips": 0,
                "chips": []
            }), 200

        current_time = time.time()
        validated_chips = []

        # Check each chip in the user's Google Account against live RAM pings
        for c in account_chips:
            c_name = c.get('chipName', '').strip()
            c_pass = c.get('chipPassword', '').strip()

            live_data = live_chips_ram.get(c_name)
            is_online = False
            ip_address = "unassigned"

            # Check if chip exists in server RAM and password matches
            if live_data and live_data.get('chipPassword') == c_pass:
                # Online if pinged within the last 45 seconds
                is_online = (current_time - live_data.get('lastSeen', 0)) < 45
                ip_address = live_data.get('ipAddress', 'unassigned')

            validated_chips.append({
                "chipName": c_name,
                "chipPassword": c_pass,
                "isOnline": is_online,
                "ipAddress": ip_address
            })

        return jsonify({
            "success": True,
            "email": email,
            "status": "Available",
            "totalChips": len(validated_chips),
            "chips": validated_chips
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# -------------------------------------------------------------------
# 2. ADD / CLAIM CHIP MANUALLY
# -------------------------------------------------------------------
@app.route('/api/chips/add-manual', methods=['POST'])
def add_chip_manually():
    try:
        data = request.get_json() or {}
        email = data.get('email', '').strip().lower()
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()

        if not email or not chip_name or not chip_password:
            return jsonify({"success": False, "error": "Missing email, chipName, or chipPassword."}), 400

        live_data = live_chips_ram.get(chip_name)

        # Verify chip is currently powered ON or known to the server
        if not live_data:
            return jsonify({
                "success": False, 
                "error": f"Chip '{chip_name}' is not detected on the server network. Make sure it is powered ON."
            }), 404

        # Verify security password
        if live_data.get('chipPassword') != chip_password:
            return jsonify({
                "success": False, 
                "error": "Invalid Chip Password! Verification failed."
            }), 401

        current_time = time.time()
        is_online = (current_time - live_data.get('lastSeen', 0)) < 45

        return jsonify({
            "success": True,
            "message": f"Chip '{chip_name}' verified successfully! Ready to link to {email}.",
            "chip": {
                "chipName": chip_name,
                "chipPassword": chip_password,
                "isOnline": is_online,
                "ipAddress": live_data.get('ipAddress', 'unassigned')
            }
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# -------------------------------------------------------------------
# 3. PHYSICAL ESP8266 PING / HEARTBEAT
# -------------------------------------------------------------------
@app.route('/api/chips/ping', methods=['POST'])
def chip_ping():
    try:
        data = request.get_json() or {}
        chip_name = data.get('chipName', '').strip()
        chip_password = data.get('chipPassword', '').strip()
        ip_address = data.get('ipAddress', 'unassigned').strip()

        if not chip_name or not chip_password:
            return jsonify({"success": False, "error": "Missing credentials"}), 400

        # Store or update chip heartbeat in RAM
        live_chips_ram[chip_name] = {
            "chipPassword": chip_password,
            "ipAddress": ip_address,
            "lastSeen": time.time()
        }

        return jsonify({"success": True, "message": f"Ping received for {chip_name}"}), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    app.run(host='0.0.0.0', port=port)
